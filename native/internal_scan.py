"""Bounded offline static risk signals; never an antivirus clean verdict.

No signatures are fetched, files executed, archives expanded, or payloads logged.
A completed pass only means these limited rules found no signals.
"""
from __future__ import annotations

from pathlib import Path
import re
import struct
from typing import BinaryIO

ENGINE = "builtin-static-v1"
CHUNK_BYTES = 64 * 1024
MAX_BYTES = 2 * 1024 * 1024 * 1024 - 1
MAX_FINDINGS = 16
MAX_PE_CANDIDATES = 4096
MAX_DOS_CANDIDATES = 1_000_000
MAX_ZIP_CANDIDATES = 128
MAX_ZIP_ENTRIES = 1024
MAX_ZIP_DIRECTORY = 2 * 1024 * 1024
# Standard harmless antivirus TEST marker. Numeric representation avoids shipping
# a literal marker in source/install archives or confusing it with real malware.
TEST_MARKER = bytes((88, 53, 79, 33, 80, 37, 64, 65, 80, 91, 52, 92, 80, 90, 88,
                     53, 52, 40, 80, 94, 41, 55, 67, 67, 41, 55, 125, 36, 69,
                     73, 67, 65, 82, 45, 83, 84, 65, 78, 68, 65, 82, 68, 45,
                     65, 78, 84, 73, 86, 73, 82, 85, 83, 45, 84, 69, 83, 84,
                     45, 70, 73, 76, 69, 33, 36, 72, 43, 72, 42))


def _known_media(head: bytes, size: int) -> bool:
    if head.startswith((b"\xff\xfe", b"\xfe\xff")):
        return False
    return (len(head) >= 12 and head[4:8] in (b"ftyp", b"moov", b"mdat")
            or head.startswith((b"\x1aE\xdf\xa3", b"OggS", b"fLaC", b"ID3", b"\x89PNG\r\n\x1a\n", b"\xff\xd8\xff", b"GIF87a", b"GIF89a"))
            or len(head) >= 12 and head[:4] == b"RIFF" and head[8:12] in (b"AVI ", b"WAVE", b"WEBP")
            or len(head) >= 2 and head[0] == 255 and head[1] & 224 == 224
            or size >= 377 and len(head) >= 377 and head[0] == head[188] == head[376] == 71)


def _read_at(stream: BinaryIO, position: int, length: int, size: int) -> bytes:
    if position < 0 or length < 0 or position + length > size:
        return b""
    stream.seek(position)
    result = bytearray()
    while len(result) < length:
        part = stream.read(min(CHUNK_BYTES, length - len(result)))
        if not part:
            break
        result.extend(part)
    return bytes(result)


def _valid_pe(stream: BinaryIO, start: int, size: int) -> bool:
    """Require coherent PE headers/sections, not an incidental MZ byte pair."""
    dos = _read_at(stream, start, 64, size)
    if len(dos) != 64 or dos[:2] != b"MZ":
        return False
    pe_offset = struct.unpack_from("<I", dos, 60)[0]
    if not 64 <= pe_offset <= 1024 * 1024:
        return False
    coff = _read_at(stream, start + pe_offset, 24, size)
    if len(coff) != 24 or coff[:4] != b"PE\0\0":
        return False
    machine, sections = struct.unpack_from("<HH", coff, 4)
    optional_size, characteristics = struct.unpack_from("<HH", coff, 20)
    if machine not in (0x14c, 0x8664, 0xaa64, 0x1c0, 0x1c4) or not 1 <= sections <= 96 or not characteristics & 2:
        return False
    if not 96 <= optional_size <= 4096:
        return False
    optional = _read_at(stream, start + pe_offset + 24, optional_size, size)
    if len(optional) != optional_size:
        return False
    magic = struct.unpack_from("<H", optional)[0]
    if magic not in (0x10b, 0x20b) or optional_size < (112 if magic == 0x20b else 96):
        return False
    image_size, headers_size = struct.unpack_from("<II", optional, 56)
    table_end = pe_offset + 24 + optional_size + sections * 40
    remaining = size - start
    if not table_end <= headers_size <= remaining or image_size < headers_size:
        return False
    table = _read_at(stream, start + pe_offset + 24 + optional_size, sections * 40, size)
    if len(table) != sections * 40:
        return False
    has_data = False
    for index in range(sections):
        raw_size, raw_offset = struct.unpack_from("<II", table, index * 40 + 16)
        if raw_size:
            if raw_offset < headers_size or raw_offset + raw_size > remaining:
                return False
            has_data = True
    return has_data


def _valid_elf(head: bytes) -> bool:
    if len(head) < 52 or head[:4] != b"\x7fELF" or head[4] not in (1, 2) or head[5] not in (1, 2) or head[6] != 1:
        return False
    order = "<" if head[5] == 1 else ">"
    expected = 52 if head[4] == 1 else 64
    if len(head) < expected:
        return False
    kind, machine = struct.unpack_from(order + "HH", head, 16)
    header_size = struct.unpack_from(order + "H", head, 40 if head[4] == 1 else 52)[0]
    return kind in (2, 3) and machine != 0 and header_size == expected


def _valid_mach_o(head: bytes) -> bool:
    if len(head) < 28:
        return False
    magic = head[:4]
    if magic not in (b"\xfe\xed\xfa\xce", b"\xce\xfa\xed\xfe", b"\xfe\xed\xfa\xcf", b"\xcf\xfa\xed\xfe"):
        return False
    order = ">" if magic[0] == 254 else "<"
    cpu, _, kind, count, command_bytes = struct.unpack_from(order + "IIIII", head, 4)
    return cpu in (7, 12, 0x1000007, 0x100000c) and kind in (2, 6, 8) and 0 < count <= 4096 and 8 <= command_bytes <= 16 * 1024 * 1024


def _zip_candidate(stream: BinaryIO, end: bytes, eocd_position: int, size: int) -> tuple[bool, bool]:
    if len(end) < 22:
        return False, False
    disk, cd_disk, disk_entries, entries, cd_size, cd_offset, comment = struct.unpack_from("<HHHHIIH", end, 4)
    if len(end) != 22 + comment or disk or cd_disk or not entries or disk_entries != entries:
        return False, False
    if entries == 0xffff or cd_offset == 0xffffffff or cd_size == 0xffffffff or entries > MAX_ZIP_ENTRIES or cd_size > MAX_ZIP_DIRECTORY:
        return False, True
    archive_start = eocd_position - cd_size - cd_offset
    cd_start = archive_start + cd_offset
    if archive_start < 0 or cd_start < 0 or cd_start + cd_size != eocd_position:
        return False, False
    cursor = cd_start
    first_local = size
    for _ in range(entries):
        record = _read_at(stream, cursor, 46, size)
        if len(record) != 46 or record[:4] != b"PK\x01\x02":
            return False, False
        flags, method = struct.unpack_from("<HH", record, 8)
        compressed = struct.unpack_from("<I", record, 20)[0]
        name_size, extra_size, comment_size, entry_disk = struct.unpack_from("<HHHH", record, 28)
        local_offset = struct.unpack_from("<I", record, 42)[0]
        next_cursor = cursor + 46 + name_size + extra_size + comment_size
        if entry_disk or not name_size or next_cursor > eocd_position or local_offset == 0xffffffff or compressed == 0xffffffff:
            return False, False
        name = _read_at(stream, cursor + 46, name_size, size)
        local = archive_start + local_offset
        header = _read_at(stream, local, 30, size)
        if len(header) != 30 or header[:4] != b"PK\x03\x04" or local >= cd_start:
            return False, False
        local_flags, local_method = struct.unpack_from("<HH", header, 6)
        local_name_size, local_extra_size = struct.unpack_from("<HH", header, 26)
        data_start = local + 30 + local_name_size + local_extra_size
        if local_flags != flags or local_method != method or local_name_size != name_size or data_start + compressed > cd_start:
            return False, False
        if _read_at(stream, local + 30, name_size, size) != name:
            return False, False
        first_local = min(first_local, local)
        cursor = next_cursor
    return cursor == eocd_position and first_local > 0, False


def _appended_zip(stream: BinaryIO, tail: bytes, size: int) -> tuple[bool, bool]:
    """EOCD-looking bytes in a legal ZIP comment must not hide its real EOF record."""
    position = tail.rfind(b"PK\x05\x06")
    candidates = 0
    limited = False
    while position >= 0:
        candidates += 1
        if candidates > MAX_ZIP_CANDIDATES:
            return False, True
        found, limit = _zip_candidate(stream, tail[position:], size - len(tail) + position, size)
        if found:
            return True, limited
        limited = limited or limit
        position = tail.rfind(b"PK\x05\x06", 0, position)
    return False, limited


def scan_file(path: Path, *, max_bytes: int = MAX_BYTES, expected_media: bool = True) -> dict:
    """Scan all supplied regular-file bytes or explicitly report incomplete."""
    if type(max_bytes) is not int or max_bytes < 0 or max_bytes > MAX_BYTES:
        raise ValueError("Invalid internal scan limit.")
    size = path.stat().st_size
    findings: list[dict] = []
    seen: set[tuple[str, int]] = set()
    complete = size <= max_bytes
    scanned = 0
    def add(rule: str, message: str, offset: int | None = None, severity: str = "warning") -> None:
        key = (rule, -1 if offset is None else offset)
        if key not in seen:
            finding = {"id": rule, "severity": severity, "message": message}
            if offset is not None:
                finding["offset"] = offset
            if len(findings) < MAX_FINDINGS:
                findings.append(finding)
                seen.add(key)
            elif rule == "analysis-limit":
                findings[-1] = finding
                seen.add(key)
    with path.open("rb") as stream, path.open("rb") as probe:
        head = stream.read(min(4096, max_bytes))
        media = _known_media(head, size)
        if expected_media and _valid_elf(head):
            add("executable-elf", "영상 대신 ELF 실행 파일 구조가 발견됐습니다.", severity="high")
        if expected_media and _valid_mach_o(head):
            add("executable-mach-o", "영상 대신 Mach-O 실행 파일 구조가 발견됐습니다.", severity="high")
        if head.startswith((b"\xff\xfe", b"\xfe\xff")):
            stripped = head.decode("utf-16", errors="ignore").lstrip().encode("utf-8")
        else:
            stripped = head.removeprefix(b"\xef\xbb\xbf").lstrip(b"\x00\t\r\n ")
        if expected_media:
            if stripped.startswith((b"PK\x03\x04", b"7z\xbc\xaf\x27\x1c", b"Rar!\x1a\x07", b"\x1f\x8b")):
                add("non-media-archive", "영상 대신 압축 파일 구조가 발견됐습니다. 압축 내용을 내부 검사하지 않았습니다.")
            if stripped.startswith(b"%PDF-"):
                add("non-media-pdf", "영상 대신 PDF 문서 구조가 발견됐습니다.")
            if re.match(br"(?:#![^\r\n]{1,240}|<(?:!doctype\s+html|html\b|script\b|svg\b)|<\?php\b|@echo\s+off\b|powershell(?:\.exe)?\s)", stripped[:256], re.IGNORECASE):
                add("non-media-script", "영상 대신 스크립트 또는 활성 문서 형식이 발견됐습니다.", severity="high")
        stream.seek(0)
        carry = b""
        pe_candidates = 0
        dos_candidates = 0
        exhausted = False
        while scanned < min(size, max_bytes):
            chunk = stream.read(min(CHUNK_BYTES, min(size, max_bytes) - scanned))
            if not chunk:
                complete = False
                break
            window = carry + chunk
            base = scanned - len(carry)
            marker = window.find(TEST_MARKER)
            if marker >= 0:
                add("eicar-test-marker", "표준 무해한 EICAR 백신 시험 문자열이 발견됐습니다. 실제 악성코드 판정은 아닙니다.", base + marker, "high")
            if not exhausted:
                # Revisit only the one-byte boundary, not old carry candidates.
                position = window.find(b"MZ", max(0, len(carry) - 1))
                while position >= 0:
                    absolute = base + position
                    dos_candidates += 1
                    if dos_candidates > MAX_DOS_CANDIDATES:
                        complete = False
                        exhausted = True
                        add("analysis-limit", "실행 파일 후보 분석 한도에 도달해 내부 검사가 불완전합니다.")
                        break
                    # Random compressed bytes contain many MZ pairs. Budget
                    # expensive section validation only after coherent DOS/COFF.
                    dos = window[position:position + 64]
                    if len(dos) != 64:
                        dos = _read_at(probe, absolute, 64, min(size, max_bytes))
                    pe_offset = struct.unpack_from("<I", dos, 60)[0] if len(dos) == 64 else 0
                    if 64 <= pe_offset <= 1024 * 1024:
                        coff = _read_at(probe, absolute + pe_offset, 24, min(size, max_bytes))
                        if len(coff) == 24 and coff[:4] == b"PE\0\0":
                            pe_candidates += 1
                            if pe_candidates > MAX_PE_CANDIDATES:
                                complete = False
                                exhausted = True
                                add("analysis-limit", "실행 파일 후보 분석 한도에 도달해 내부 검사가 불완전합니다.")
                                break
                            if _valid_pe(probe, absolute, min(size, max_bytes)):
                                add("executable-pe" if absolute == 0 else "embedded-pe", "영상 대신 PE 실행 파일 구조가 발견됐습니다." if absolute == 0 else "미디어 내부에 유효한 PE 실행 파일 구조가 포함돼 있습니다.", absolute, "high")
                    position = window.find(b"MZ", position + 2)
            scanned += len(chunk)
            carry = window[-(len(TEST_MARKER) - 1):]
        if size > max_bytes:
            add("analysis-limit", "내부 검사 크기 한도를 넘어 파일 전체를 확인하지 못했습니다.")
        if not size:
            complete = False
            add("empty-input", "빈 파일은 내부 검사할 수 없습니다.")
        elif expected_media and not media and not findings:
            complete = False
            add("unsupported-format", "미디어 형식을 식별하지 못해 내부 검사가 불완전합니다.")
        if complete and media:
            tail = _read_at(probe, max(0, size - 65557), min(size, 65557), size)
            appended, limited = _appended_zip(probe, tail, size)
            if appended:
                add("appended-zip", "미디어 뒤에 구조가 유효한 ZIP 압축 내용이 붙어 있습니다. 내부 항목은 검사하지 않았습니다.")
            if limited:
                complete = False
                add("analysis-limit", "첨부 압축 구조가 분석 한도를 넘어 내부 검사가 불완전합니다.")
    suspicious = any(item["id"] not in ("analysis-limit", "empty-input", "unsupported-format", "partial-input") for item in findings)
    return {"version": 1, "engine": ENGINE, "status": "suspicious" if suspicious else "no-signals" if complete else "incomplete",
            "scannedBytes": scanned, "complete": complete, "findings": findings}
