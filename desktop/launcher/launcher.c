/* Native Windows GUI entry point. No shell, PATH lookup, or C runtime. */
#define WIN32_LEAN_AND_MEAN
#define UNICODE
#define _UNICODE
#include <windows.h>

#define CAPACITY 32768

static WCHAR app_root[CAPACITY];
static WCHAR python_path[CAPACITY];
static WCHAR script_path[CAPACITY];
static WCHAR command_line[CAPACITY];
static WCHAR error_text[2048];
static STARTUPINFOW startup;
static PROCESS_INFORMATION process;

static DWORD text_length(const WCHAR *value) {
    DWORD size = 0;
    while (value[size]) ++size;
    return size;
}

static BOOL append(WCHAR *target, DWORD capacity, const WCHAR *value) {
    DWORD used = text_length(target), added = text_length(value);
    if (used >= capacity || added >= capacity - used) return FALSE;
    for (DWORD i = 0; i <= added; ++i) target[used + i] = value[i];
    return TRUE;
}

static void fail(const WCHAR *message, DWORD code) {
    append(error_text, 2048, message);
    if (code) {
        DWORD used = text_length(error_text);
        if (used + 4 < 2048) {
            append(error_text, 2048, L"\r\n\r\n");
            used = text_length(error_text);
            FormatMessageW(FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
                           NULL, code, 0, error_text + used, 2048 - used, NULL);
        }
    }
    MessageBoxW(NULL, error_text, L"My Video App", MB_OK | MB_ICONERROR | MB_SETFOREGROUND);
    ExitProcess(code ? code : ERROR_BAD_PATHNAME);
}

/* Reject network drives, symlinks, junctions, and non-file runtime targets. */
static BOOL local_path(WCHAR *path, BOOL directory) {
    WCHAR drive[4] = {path[0], L':', L'\\', 0};
    if (!(((path[0] >= L'A' && path[0] <= L'Z') ||
           (path[0] >= L'a' && path[0] <= L'z')) &&
          path[1] == L':' && path[2] == L'\\')) return FALSE;
    UINT kind = GetDriveTypeW(drive);
    if (kind != DRIVE_FIXED && kind != DRIVE_REMOVABLE && kind != DRIVE_RAMDISK)
        return FALSE;
    for (DWORD i = 3;; ++i) {
        WCHAR saved = path[i];
        if (saved == L'"') return FALSE;
        if (saved != L'\\' && saved != 0) continue;
        path[i] = 0;
        DWORD attributes = GetFileAttributesW(path);
        path[i] = saved;
        if (attributes == INVALID_FILE_ATTRIBUTES ||
            (attributes & FILE_ATTRIBUTE_REPARSE_POINT)) return FALSE;
        BOOL is_directory = (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
        if (saved && !is_directory) return FALSE;
        if (!saved) return directory == is_directory;
    }
}

void WINAPI launcher_entry(void) {
    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOOPENFILEERRORBOX);
    /* Removing the working directory from DLL search also applies to children. */
    SetDllDirectoryW(L"");
    DWORD length = GetModuleFileNameW(NULL, app_root, CAPACITY);
    if (length == 0 || length >= CAPACITY)
        fail(L"The application folder could not be located. Extract the complete ZIP to a local folder and try again.", GetLastError());
    while (length && app_root[length - 1] != L'\\') --length;
    if (length <= 3)
        fail(L"Extract My Video App into its own local folder before opening it.", 0);
    app_root[length - 1] = 0;
    if (!local_path(app_root, TRUE))
        fail(L"Open My Video App from a local folder without folder links. Extract the complete ZIP first.", 0);
    if (!append(python_path, CAPACITY, app_root) ||
        !append(python_path, CAPACITY, L"\\runtime\\python\\pythonw.exe") ||
        !append(script_path, CAPACITY, app_root) ||
        !append(script_path, CAPACITY, L"\\desktop\\main.py"))
        fail(L"The application folder path is too long. Extract the ZIP to a shorter local folder.", 0);
    if (!local_path(python_path, FALSE) || !local_path(script_path, FALSE))
        fail(L"The bundled application files are missing or linked elsewhere. Extract the complete ZIP again, then open My Video App.exe. Installing Python is unnecessary.", 0);
    if (!append(command_line, CAPACITY, L"\"") ||
        !append(command_line, CAPACITY, python_path) ||
        !append(command_line, CAPACITY, L"\" -I -B \"") ||
        !append(command_line, CAPACITY, script_path) ||
        !append(command_line, CAPACITY, L"\""))
        fail(L"The application folder path is too long. Extract the ZIP to a shorter local folder.", 0);
    startup.cb = sizeof(startup);
    if (!CreateProcessW(python_path, command_line, NULL, NULL, FALSE,
                        CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | CREATE_DEFAULT_ERROR_MODE,
                        NULL, app_root, &startup, &process))
        fail(L"Windows could not start the bundled application. Extract the complete ZIP to a local folder and try again.", GetLastError());
    CloseHandle(process.hThread);
    if (WaitForSingleObject(process.hProcess, INFINITE) == WAIT_FAILED)
        fail(L"Windows could not wait for the application to finish.", GetLastError());
    DWORD exit_code = 0;
    if (!GetExitCodeProcess(process.hProcess, &exit_code))
        fail(L"Windows could not read the application result.", GetLastError());
    CloseHandle(process.hProcess);
    if (exit_code != 0)
        MessageBoxW(NULL,
                    L"앱을 시작할 수 없습니다.\r\n\r\nZIP 파일을 새 로컬 폴더에 모두 풀었는지 확인하고, 문제가 계속되면 최신 ZIP을 다시 받아 주세요.",
                    L"My Video App", MB_OK | MB_ICONERROR | MB_SETFOREGROUND);
    ExitProcess(exit_code);
}
