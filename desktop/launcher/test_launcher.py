"""Exercise the real C entry point with mocked Win32 APIs; inspect the real PE."""
import pathlib
import shutil
import subprocess
import tempfile
import unittest

from verify_pe import inspect_launcher

HERE = pathlib.Path(__file__).resolve().parent

WIN32_STUB = r'''
#include <stdint.h>
#include <stddef.h>
#include <wchar.h>
typedef wchar_t WCHAR;
typedef uint32_t DWORD;
typedef unsigned int UINT;
typedef int BOOL;
typedef void *HANDLE;
#define WINAPI
#define TRUE 1
#define FALSE 0
#define MB_OK 0
#define MB_ICONERROR 16
#define MB_SETFOREGROUND 65536
#define ERROR_BAD_PATHNAME 161
#define SEM_FAILCRITICALERRORS 1
#define SEM_NOOPENFILEERRORBOX 32768
#define FORMAT_MESSAGE_FROM_SYSTEM 4096
#define FORMAT_MESSAGE_IGNORE_INSERTS 512
#define DRIVE_FIXED 3
#define DRIVE_REMOVABLE 2
#define DRIVE_RAMDISK 6
#define FILE_ATTRIBUTE_DIRECTORY 16
#define FILE_ATTRIBUTE_REPARSE_POINT 1024
#define INVALID_FILE_ATTRIBUTES ((DWORD)-1)
#define CREATE_NO_WINDOW 134217728
#define CREATE_UNICODE_ENVIRONMENT 1024
#define CREATE_DEFAULT_ERROR_MODE 67108864
#define INFINITE ((DWORD)-1)
#define WAIT_FAILED ((DWORD)-1)
typedef struct { DWORD cb; } STARTUPINFOW;
typedef struct { HANDLE hProcess; HANDLE hThread; } PROCESS_INFORMATION;
DWORD GetLastError(void);
DWORD SetErrorMode(DWORD);
BOOL SetDllDirectoryW(const WCHAR *);
DWORD GetModuleFileNameW(HANDLE, WCHAR *, DWORD);
UINT GetDriveTypeW(const WCHAR *);
DWORD GetFileAttributesW(const WCHAR *);
DWORD FormatMessageW(DWORD, const void *, DWORD, DWORD, WCHAR *, DWORD, void *);
int MessageBoxW(HANDLE, const WCHAR *, const WCHAR *, UINT);
_Noreturn void ExitProcess(DWORD);
BOOL CreateProcessW(const WCHAR *, WCHAR *, void *, void *, BOOL, DWORD, void *, const WCHAR *, STARTUPINFOW *, PROCESS_INFORMATION *);
BOOL CloseHandle(HANDLE);
DWORD WaitForSingleObject(HANDLE, DWORD);
BOOL GetExitCodeProcess(HANDLE, DWORD *);
'''

HARNESS = r'''
#include <assert.h>
#include <setjmp.h>
#include <stdlib.h>
#include "launcher.c"
static jmp_buf completed;
static DWORD result;
static int scenario, dialogs, starts;
DWORD GetLastError(void) { return 2; }
DWORD SetErrorMode(DWORD mode) { (void)mode; return 0; }
BOOL SetDllDirectoryW(const WCHAR *path) { assert(!*path); return TRUE; }
DWORD GetModuleFileNameW(HANDLE module, WCHAR *path, DWORD capacity) {
    (void)module; (void)capacity;
    const WCHAR *name = L"C:\\앱 폴더\\My Video App.exe";
    wcscpy(path, name);
    return (DWORD)wcslen(name);
}
UINT GetDriveTypeW(const WCHAR *path) { assert(!wcscmp(path, L"C:\\")); return DRIVE_FIXED; }
DWORD GetFileAttributesW(const WCHAR *path) {
    if (scenario == 3 && wcsstr(path, L"runtime"))
        return FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT;
    return wcsstr(path, L".exe") || wcsstr(path, L".py") ? 0 : FILE_ATTRIBUTE_DIRECTORY;
}
DWORD FormatMessageW(DWORD flags, const void *source, DWORD code, DWORD lang, WCHAR *text, DWORD size, void *args) {
    (void)flags; (void)source; (void)code; (void)lang; (void)size; (void)args;
    *text = 0; return 0;
}
int MessageBoxW(HANDLE window, const WCHAR *text, const WCHAR *title, UINT flags) {
    (void)window; (void)flags;
    assert(!wcscmp(title, L"My Video App"));
    assert(wcsstr(text, L"ZIP"));
    if (scenario == 1) assert(wcsstr(text, L"앱을 시작할 수 없습니다"));
    ++dialogs; return 0;
}
_Noreturn void ExitProcess(DWORD code) { result = code; longjmp(completed, 1); }
BOOL CreateProcessW(const WCHAR *app, WCHAR *command, void *process_security, void *thread_security, BOOL handles, DWORD flags, void *environment, const WCHAR *cwd, STARTUPINFOW *info, PROCESS_INFORMATION *created) {
    (void)process_security; (void)thread_security;
    assert(!wcscmp(app, L"C:\\앱 폴더\\runtime\\python\\pythonw.exe"));
    assert(!wcscmp(command, L"\"C:\\앱 폴더\\runtime\\python\\pythonw.exe\" -I -B \"C:\\앱 폴더\\desktop\\main.py\""));
    assert(!wcscmp(cwd, L"C:\\앱 폴더"));
    assert(handles == FALSE && environment == NULL && info->cb == sizeof(*info));
    assert(flags == (CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | CREATE_DEFAULT_ERROR_MODE));
    created->hThread = (HANDLE)1; created->hProcess = (HANDLE)2;
    ++starts; return scenario != 2;
}
BOOL CloseHandle(HANDLE handle) { (void)handle; return TRUE; }
DWORD WaitForSingleObject(HANDLE handle, DWORD timeout) { (void)handle; assert(timeout == INFINITE); return 0; }
BOOL GetExitCodeProcess(HANDLE handle, DWORD *code) { (void)handle; *code = scenario == 1 ? 37 : 0; return TRUE; }
int main(int argc, char **argv) {
    assert(argc == 2); scenario = atoi(argv[1]);
    if (!setjmp(completed)) launcher_entry();
    assert(result == (scenario == 1 ? 37 : scenario == 2 ? 2 : scenario == 3 ? ERROR_BAD_PATHNAME : 0));
    assert(dialogs == (scenario != 0));
    assert(starts == (scenario != 3));
    return 0;
}
'''


class LauncherEntryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        compiler = shutil.which("cc") or shutil.which("gcc") or shutil.which("clang")
        if not compiler:
            raise unittest.SkipTest("A host C compiler is required for the Win32 API harness")
        cls.temporary = tempfile.TemporaryDirectory(prefix="my-video-launcher-test-")
        folder = pathlib.Path(cls.temporary.name)
        (folder / "windows.h").write_text(WIN32_STUB, encoding="utf-8")
        (folder / "test.c").write_text(HARNESS, encoding="utf-8")
        cls.executable = folder / "launcher-test"
        subprocess.run([compiler, "-std=c11", "-Wall", "-Wextra", "-Werror", "-I", str(folder), "-I", str(HERE), str(folder / "test.c"), "-o", str(cls.executable)], check=True)

    @classmethod
    def tearDownClass(cls):
        if hasattr(cls, "temporary"):
            cls.temporary.cleanup()

    def test_success_does_not_display_error(self):
        subprocess.run([str(self.executable), "0"], check=True)

    def test_child_failure_shows_recovery_dialog_and_preserves_code(self):
        subprocess.run([str(self.executable), "1"], check=True)

    def test_process_creation_failure_shows_error(self):
        subprocess.run([str(self.executable), "2"], check=True)

    def test_linked_runtime_is_rejected_before_process_creation(self):
        subprocess.run([str(self.executable), "3"], check=True)


class LauncherBinaryTests(unittest.TestCase):
    def test_built_binary_is_native_windows_gui_with_only_system_imports(self):
        executable = HERE / "MyVideoApp.exe"
        if not executable.exists():
            self.skipTest("Build the launcher to inspect the Windows PE")
        report = inspect_launcher(executable)
        self.assertEqual(report["machine"], "AMD64")
        self.assertFalse(report["crt_dependency"])
        self.assertFalse(report["dotnet_dependency"])


if __name__ == "__main__":
    unittest.main()
