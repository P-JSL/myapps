"""Inspect the launcher PE without executing Windows code."""
from __future__ import annotations

import hashlib
import pathlib
import struct


def inspect_launcher(path: pathlib.Path) -> dict:
    data = path.read_bytes()
    if data[:2] != b"MZ":
        raise ValueError("Launcher is not a PE executable")
    pe = struct.unpack_from("<I", data, 0x3C)[0]
    if data[pe:pe + 4] != b"PE\0\0":
        raise ValueError("Invalid PE signature")
    machine, count = struct.unpack_from("<HH", data, pe + 4)
    optional_size = struct.unpack_from("<H", data, pe + 20)[0]
    optional = pe + 24
    magic = struct.unpack_from("<H", data, optional)[0]
    if machine != 0x8664 or magic != 0x20B:
        raise ValueError("Launcher must be native AMD64 PE32+")
    entry = struct.unpack_from("<I", data, optional + 16)[0]
    subsystem, dll_flags = struct.unpack_from("<HH", data, optional + 68)
    if subsystem != 2 or not entry:
        raise ValueError("Launcher must have a Windows GUI entry point")
    if dll_flags & 0x160 != 0x160:
        raise ValueError("Launcher requires ASLR, high-entropy ASLR and DEP")
    sections = []
    for number in range(count):
        offset = optional + optional_size + number * 40
        virtual_size, rva, raw_size, raw = struct.unpack_from("<IIII", data, offset + 8)
        sections.append((rva, max(virtual_size, raw_size), raw))

    def file_offset(rva):
        for start, size, raw in sections:
            if start <= rva < start + size:
                return raw + rva - start
        raise ValueError(f"Unmapped PE RVA: {rva:x}")

    imports_rva, imports_size = struct.unpack_from("<II", data, optional + 112 + 8)
    imports = []
    if not imports_rva or not imports_size:
        raise ValueError("Launcher has no Windows imports")
    cursor = file_offset(imports_rva)
    while True:
        descriptor = struct.unpack_from("<IIIII", data, cursor)
        if not any(descriptor):
            break
        name_offset = file_offset(descriptor[3])
        end = data.index(b"\0", name_offset)
        imports.append(data[name_offset:end].decode("ascii"))
        cursor += 20
    if {name.lower() for name in imports} != {"kernel32.dll", "user32.dll"}:
        raise ValueError(f"Unexpected runtime imports: {imports}")
    resources_rva, resources_size = struct.unpack_from("<II", data, optional + 112 + 16)
    clr_rva, clr_size = struct.unpack_from("<II", data, optional + 112 + 14 * 8)
    if clr_rva or clr_size:
        raise ValueError("Launcher unexpectedly requires .NET")
    if not resources_rva or not resources_size:
        raise ValueError("Launcher is missing manifest/version resources")
    return {
        "path": str(path), "size": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "machine": "AMD64", "format": "PE32+", "subsystem": "Windows GUI",
        "imports": imports, "crt_dependency": False, "dotnet_dependency": False,
        "aslr": True, "high_entropy_aslr": True, "dep": True,
        "resources": True, "windows_execution_tested": False,
    }


if __name__ == "__main__":
    import argparse
    import json
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("executable", type=pathlib.Path)
    args = parser.parse_args()
    print(json.dumps(inspect_launcher(args.executable), indent=2))
