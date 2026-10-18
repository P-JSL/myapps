#!/usr/bin/env python3
"""Read-only Windows antivirus inventory and a bounded Windows AMSI scan worker.

Security Center is an inventory API, not a generic scan API. Third-party routing
therefore requires an installed AMSI provider that conservatively matches the
active product. An AMSI verdict is attributed to Windows AMSI, which does not
identify the provider that returned it. No reported executable path is invoked.
"""
from __future__ import annotations

import ctypes
import json
import os
from pathlib import Path
import re
import stat
import sys

MAX_AMSI_FILE = 128 * 1024 * 1024

# These COM interfaces inherit IDispatch in the Windows SDK's iwscapi.h. The
# explicit four IDispatch slots below preserve their native vtable layout.
# WSC_SECURITY_PROVIDER_ANTIVIRUS = 4; WSC_SECURITY_PRODUCT_STATE_ON = 0.
# Query only; do not use WMI's undocumented productState bitfield as a verdict.
DISCOVERY_SCRIPT = r'''
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

[ComImport, Guid("8C38232E-3A45-4A27-92B0-1A16A975F669"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMyVideoWscProduct {
  [PreserveSig] int GetTypeInfoCount(out uint count);
  [PreserveSig] int GetTypeInfo(uint index, uint locale, out IntPtr info);
  [PreserveSig] int GetIDsOfNames(ref Guid iid, IntPtr names, uint count, uint locale, IntPtr ids);
  [PreserveSig] int Invoke(int id, ref Guid iid, uint locale, ushort flags, IntPtr args, IntPtr result, IntPtr error, IntPtr argumentError);
  [PreserveSig] int get_ProductName([MarshalAs(UnmanagedType.BStr)] out string name);
  [PreserveSig] int get_ProductState(out int state);
}
[ComImport, Guid("722A338C-6E8E-4e72-AC27-1417FB0C81C2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMyVideoWscProductList {
  [PreserveSig] int GetTypeInfoCount(out uint count);
  [PreserveSig] int GetTypeInfo(uint index, uint locale, out IntPtr info);
  [PreserveSig] int GetIDsOfNames(ref Guid iid, IntPtr names, uint count, uint locale, IntPtr ids);
  [PreserveSig] int Invoke(int id, ref Guid iid, uint locale, ushort flags, IntPtr args, IntPtr result, IntPtr error, IntPtr argumentError);
  [PreserveSig] int Initialize(uint provider);
  [PreserveSig] int get_Count(out int count);
  [PreserveSig] int get_Item(uint index, [MarshalAs(UnmanagedType.Interface)] out IMyVideoWscProduct product);
}
public sealed class MyVideoWscRecord {
  public string Name;
  public int State;
}
public static class MyVideoWscInventory {
  public static MyVideoWscRecord[] GetProducts() {
    object instance = null;
    try {
      instance = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("17072F7B-9ABE-4A74-A261-1EB76B55107A"), true));
      IMyVideoWscProductList list = (IMyVideoWscProductList)instance;
      Marshal.ThrowExceptionForHR(list.Initialize(4));
      int count;
      Marshal.ThrowExceptionForHR(list.get_Count(out count));
      if (count < 0 || count > 32) throw new InvalidOperationException("Invalid Security Center inventory size.");
      List<MyVideoWscRecord> products = new List<MyVideoWscRecord>();
      for (uint index = 0; index < count; index++) {
        IMyVideoWscProduct product = null;
        try {
          Marshal.ThrowExceptionForHR(list.get_Item(index, out product));
          string name;
          int state;
          Marshal.ThrowExceptionForHR(product.get_ProductName(out name));
          Marshal.ThrowExceptionForHR(product.get_ProductState(out state));
          products.Add(new MyVideoWscRecord { Name = name, State = state });
        } finally {
          if (product != null) Marshal.ReleaseComObject(product);
        }
      }
      return products.ToArray();
    } finally {
      if (instance != null) Marshal.ReleaseComObject(instance);
    }
  }
}
'@
  $products = @([MyVideoWscInventory]::GetProducts() | ForEach-Object {
    $state = switch ($_.State) { 0 {'on'} 1 {'off'} 2 {'snoozed'} 3 {'expired'} default {'unknown'} }
    @{ name = $_.Name; state = $state }
  })
  # Match the Python AMSI worker's architecture, rather than inspecting a provider
  # registered only for the other bitness. Registry values are never executed.
  $view = if (__MVA_PYTHON_POINTER_BITS__ -eq 64) { [Microsoft.Win32.RegistryView]::Registry64 } else { [Microsoft.Win32.RegistryView]::Registry32 }
  $machine = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, $view)
  $providers = @()
  try {
    $registered = $machine.OpenSubKey('SOFTWARE\Microsoft\AMSI\Providers', $false)
    if ($null -ne $registered) {
      try {
        foreach ($id in $registered.GetSubKeyNames()) {
          if ($providers.Count -ge 64) { throw 'Too many registered AMSI providers.' }
          $guid = [Guid]::Empty
          if (-not [Guid]::TryParse($id, [ref]$guid)) { continue }
          $server = $machine.OpenSubKey(('SOFTWARE\Classes\CLSID\' + $id + '\InprocServer32'), $false)
          if ($null -eq $server) { continue }
          try { $dll = [string]$server.GetValue('') } finally { $server.Dispose() }
          $dll = [Environment]::ExpandEnvironmentVariables($dll).Trim().Trim('"')
          if ($dll -notmatch '^[A-Za-z]:\\' -or -not [IO.File]::Exists($dll)) { continue }
          $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($dll)
          $identity = (@($version.CompanyName, $version.ProductName, $version.FileDescription) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join ' '
          if (-not [string]::IsNullOrWhiteSpace($identity)) { $providers += @{ identity = $identity } }
        }
      } finally { $registered.Dispose() }
    }
  } finally { $machine.Dispose() }
  @{ status = 'ok'; products = @($products); providers = @($providers) } | ConvertTo-Json -Depth 5 -Compress
} catch {
  @{ status = 'error'; products = @(); providers = @(); message = 'Windows Security Center or registered AMSI provider inventory could not be read.' } | ConvertTo-Json -Compress
}
'''


def _text(value: str, limit: int = 500) -> str:
    return ''.join(character for character in value if character >= ' ' and character != '\x7f')[:limit]


def discover_windows_antivirus(run_tool, powershell: Path) -> dict:
    """Return verified-shape inventory, using a caller-vetted System32 PowerShell."""
    failure = {"status": "error", "products": [], "providers": [],
               "message": "Windows Security Center or registered AMSI provider inventory could not be read."}
    script = DISCOVERY_SCRIPT.replace('__MVA_PYTHON_POINTER_BITS__', str(ctypes.sizeof(ctypes.c_void_p) * 8))
    try:
        code, output = run_tool([str(powershell), '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], 20)
        if code != 0 or len(output) > 64 * 1024:
            return failure
        value = json.loads(output.lstrip('\ufeff'))
        if not isinstance(value, dict) or value.get('status') != 'ok':
            return failure
        products, providers = value.get('products'), value.get('providers')
        if not isinstance(products, list) or not isinstance(providers, list) or len(products) > 32 or len(providers) > 64:
            return failure
        validated_products, validated_providers = [], []
        for product in products:
            if (not isinstance(product, dict) or not isinstance(product.get('name'), str)
                    or not product['name'].strip() or len(product['name']) > 500
                    or product.get('state') not in {'on', 'off', 'snoozed', 'expired', 'unknown'}):
                return failure
            validated_products.append({'name': _text(product['name']), 'state': product['state']})
        for provider in providers:
            if (not isinstance(provider, dict) or not isinstance(provider.get('identity'), str)
                    or not provider['identity'].strip() or len(provider['identity']) > 1500):
                return failure
            validated_providers.append({'identity': _text(provider['identity'], 1500)})
        return {'status': 'ok', 'products': validated_products, 'providers': validated_providers}
    except (OSError, ValueError, TypeError, RuntimeError):
        return failure


_VENDOR_ALIASES = (
    ('avast',), ('avg',), ('avira',), ('bitdefender',), ('eset',),
    ('kaspersky',), ('mcafee',), ('trend micro', 'trendmicro'), ('sophos',),
    ('norton', 'symantec'), ('malwarebytes',), ('f secure', 'fsecure'),
    ('withsecure',), ('emsisoft',), ('g data', 'gdata'), ('ahnlab',),
    ('estsecurity',), ('microsoft defender', 'windows defender'),
)


def _normalized(value: str) -> str:
    return ' '.join(re.findall(r'[a-z0-9]+', value.casefold()))


def _has_alias(value: str, aliases: tuple[str, ...]) -> bool:
    return any(' ' + alias + ' ' in ' ' + value + ' ' for alias in aliases)


def is_defender(product_name: str) -> bool:
    """Recognize the built-in product without treating another vendor as Defender."""
    if not isinstance(product_name, str):
        return False
    name = _normalized(product_name)
    matches = [aliases for aliases in _VENDOR_ALIASES if _has_alias(name, aliases)]
    return matches == [_VENDOR_ALIASES[-1]]


def provider_for_product(product_name: str, providers: list[dict]) -> bool:
    """A conservative identity match, not an assertion of runtime provider routing."""
    if not isinstance(product_name, str) or not isinstance(providers, list):
        return False
    name = _normalized(product_name)
    if not name or name in {'antivirus', 'anti virus', 'security', 'internet security',
                            'endpoint security', 'windows security', 'amsi provider'}:
        return False
    vendors = [aliases for aliases in _VENDOR_ALIASES if _has_alias(name, aliases)]
    # Unknown products need an exact full metadata identity; multiple distinct
    # vendor names in one product are ambiguous and must not auto-connect.
    if len(vendors) > 1:
        return False
    for provider in providers:
        if not isinstance(provider, dict) or not isinstance(provider.get('identity'), str):
            continue
        identity = _normalized(provider['identity'])
        if vendors:
            matched = [aliases for aliases in _VENDOR_ALIASES if _has_alias(identity, aliases)]
            if len(matched) == 1 and matched[0] == vendors[0]:
                return True
        elif len(name) >= 8 and identity == name:
            return True
    return False


def _load_amsi():
    if sys.platform != 'win32':
        raise OSError('Windows AMSI is available only on Windows.')
    # Never load an inventory-supplied DLL or resolve amsi.dll in the working dir.
    api = ctypes.WinDLL('amsi.dll', winmode=0x00000800)
    handle = ctypes.c_void_p
    api.AmsiInitialize.argtypes = [ctypes.c_wchar_p, ctypes.POINTER(handle)]
    api.AmsiInitialize.restype = ctypes.c_long
    api.AmsiOpenSession.argtypes = [handle, ctypes.POINTER(handle)]
    api.AmsiOpenSession.restype = ctypes.c_long
    api.AmsiScanBuffer.argtypes = [handle, ctypes.c_void_p, ctypes.c_uint32, ctypes.c_wchar_p,
                                 handle, ctypes.POINTER(ctypes.c_uint32)]
    api.AmsiScanBuffer.restype = ctypes.c_long
    api.AmsiCloseSession.argtypes = [handle, handle]
    api.AmsiCloseSession.restype = None
    api.AmsiUninitialize.argtypes = [handle]
    api.AmsiUninitialize.restype = None
    return api


def _check_hresult(result) -> None:
    value = getattr(result, 'value', result)
    if not isinstance(value, int) or value & 0x80000000:
        raise RuntimeError('Windows AMSI did not complete the requested operation.')


def probe_amsi(api=None) -> dict:
    """Open and close the real API without reading or scanning a user file."""
    engine = 'Windows AMSI'
    try:
        api = api if api is not None else _load_amsi()
        context, session = ctypes.c_void_p(), ctypes.c_void_p()
        try:
            _check_hresult(api.AmsiInitialize('My Video App', ctypes.byref(context)))
            if not context.value:
                raise RuntimeError('Windows AMSI returned no scan context.')
            try:
                _check_hresult(api.AmsiOpenSession(context, ctypes.byref(session)))
                if not session.value:
                    raise RuntimeError('Windows AMSI returned no scan session.')
            finally:
                if session.value:
                    api.AmsiCloseSession(context, session)
        finally:
            if context.value:
                api.AmsiUninitialize(context)
        return {'status': 'ready', 'engine': engine,
                'message': 'Windows AMSI 초기화와 도우미 연결을 확인했습니다. 파일의 위협 탐지 여부는 다운로드 후 실제 검사에서 확인합니다.'}
    except (OSError, ValueError, RuntimeError, AttributeError, TypeError, OverflowError, ctypes.ArgumentError):
        return {'status': 'unavailable', 'engine': engine,
                'message': 'Windows AMSI를 초기화하지 못했습니다. Windows 보안에서 사용 중인 백신과 표준 검사 지원을 확인하세요.'}


def scan_with_amsi(snapshot: Path, provider_name: str = '', api=None) -> dict:
    """Scan one full file buffer; caller runs this worker with a 120-second limit.

    Chunking is intentionally forbidden: some providers cannot recognize a
    signature split across buffers. Files over 128 MiB remain explicitly unscanned.
    """
    engine = 'Windows AMSI'
    try:
        with snapshot.open('rb') as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= MAX_AMSI_FILE:
                return {'status': 'unavailable', 'engine': engine,
                        'message': 'Windows AMSI scans complete nonempty files up to 128 MiB; this file was not scanned. Use a supported file scanner for larger files.'}
            data = bytearray(info.st_size)
            position = 0
            while position < len(data):
                count = source.readinto(memoryview(data)[position:])
                if not count:
                    raise RuntimeError('The file changed before the Windows AMSI scan.')
                position += count
            if source.read(1) or os.fstat(source.fileno()).st_size != info.st_size:
                raise RuntimeError('The file changed before the Windows AMSI scan.')
        api = api if api is not None else _load_amsi()
        context, session = ctypes.c_void_p(), ctypes.c_void_p()
        try:
            _check_hresult(api.AmsiInitialize('My Video App', ctypes.byref(context)))
            if not context.value:
                raise RuntimeError('Windows AMSI returned no scan context.')
            try:
                _check_hresult(api.AmsiOpenSession(context, ctypes.byref(session)))
                if not session.value:
                    raise RuntimeError('Windows AMSI returned no scan session.')
                result = ctypes.c_uint32(0xFFFFFFFF)
                buffer = (ctypes.c_ubyte * len(data)).from_buffer(data)
                _check_hresult(api.AmsiScanBuffer(context, buffer, len(data), snapshot.name,
                                                 session, ctypes.byref(result)))
                verdict = result.value
            finally:
                if session.value:
                    api.AmsiCloseSession(context, session)
        finally:
            if context.value:
                api.AmsiUninitialize(context)
        selected = _text(provider_name, 200)
        attribution = (f'Windows Security Center product: {selected}. ' if selected else '')
        attribution += 'The verdict was returned by Windows AMSI; its API does not identify the responding provider.'
        if verdict >= 0x8000 and verdict != 0xFFFFFFFF:
            return {'status': 'infected', 'engine': engine, 'threats': ['Windows AMSI malware detection'],
                    'message': attribution}
        if verdict in (0, 1):
            return {'status': 'clean', 'engine': engine, 'message': attribution}
        if 0x4000 <= verdict <= 0x4FFF:
            return {'status': 'error', 'engine': engine,
                    'message': 'Windows AMSI blocked this content under an administrator policy. Review Windows Security; no clean verdict was accepted.'}
        return {'status': 'error', 'engine': engine,
                'message': 'Windows AMSI returned an unknown or uncertain risk result; no clean verdict was accepted.'}
    except (OSError, ValueError, RuntimeError, AttributeError, TypeError, OverflowError, ctypes.ArgumentError):
        return {'status': 'error', 'engine': engine,
                'message': 'Windows AMSI could not complete a full file scan; no clean verdict was accepted.'}


def main(arguments: list[str]) -> int:
    if arguments == ['--amsi-status']:
        result = probe_amsi()
    elif len(arguments) != 3 or arguments[0] != '--amsi-scan' or len(arguments[2]) > 500:
        result = {'status': 'error', 'engine': 'Windows AMSI', 'message': 'Invalid Windows AMSI worker request.'}
    else:
        result = scan_with_amsi(Path(arguments[1]), arguments[2])
    print(json.dumps(result, ensure_ascii=True, separators=(',', ':')))
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
