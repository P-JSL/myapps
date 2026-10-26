# Windows launcher

`launcher.c` builds a native AMD64 Windows GUI executable. It opens the bundled
`runtime/python/pythonw.exe` with `-I -B` and the fixed `desktop/main.py` path.
It uses no shell, installed Python, PATH lookup, .NET or C runtime DLL. The
executable inherits the normal Windows environment; Python isolated mode ignores
Python environment variables and the user site. The launcher discards command
line arguments and requests no administrator privileges.

Extract the whole release archive into a local folder. Network drives and paths
containing symlinks or junctions are rejected. Spaces and Unicode folder names
are passed through the Unicode Windows process API. The launcher displays a
Windows error dialog for missing bundled files or process creation failures.
If the bundled interpreter exits with an error (including an import failure),
the launcher displays a Korean recovery dialog and preserves its exit code.

Build from Linux x64 (the initial toolchain download needs network access):

```sh
python desktop/launcher/build.py --fetch-toolchain
```

Or install Zig 0.17.0 separately and supply `--zig /path/to/zig`. The build uses
only pinned local compiler files after the first download. The generated
`desktop/launcher/MyVideoApp.exe` is copied to `My Video App.exe` in the release
folder alongside `runtime/` and `desktop/`. Build downloads never occur when a
user opens the app.

The build inspects the generated PE for the AMD64 architecture, GUI subsystem,
ASLR/DEP flags, manifest/version resources and the exact Windows DLL imports.
Run `python -m unittest discover -s desktop/launcher -p 'test_*.py'` to check the
actual launcher entry against mocked Windows APIs and inspect the built PE.
This Linux check does not execute the launcher on Windows. A Windows smoke test
must check opening the extracted archive from a folder with spaces and Korean
characters, startup without an installed Python, absence of a terminal window,
and the missing-runtime error dialog.
