"""MissAV page recognition and a job-local, TLS-verified HTTP/2 transport.

Independent implementation: no page scripts are executed, no cookies are imported,
and the ordinary YouTube/direct download transport is left untouched.
"""
from __future__ import annotations

import html
import importlib.metadata
import io
import os
import re
from urllib.parse import urljoin, urlsplit

UUID = r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}"
CDN = r"(?:www\.)?(?:surrit|nineyu|fourhoi)\.(?:com|store)"
DEFAULT_PAGE = "https://missav123.com/"
MAX_PAGE = 2 * 1024 * 1024
MAX_MANIFEST = 8 * 1024 * 1024


class MissavError(Exception):
    pass


def validate_playlist(data: bytes):
    if len(data) > MAX_MANIFEST:
        raise MissavError("HLS 재생목록이 처리 한도를 초과했습니다.")
    try:
        text = data.decode("utf-8-sig", errors="strict").strip()
    except UnicodeError:
        raise MissavError("서버가 올바른 HLS 재생목록을 반환하지 않았습니다.") from None
    if not text or text.splitlines()[0] != "#EXTM3U":
        raise MissavError("미디어 대신 인증·오류 페이지가 반환됐습니다. Chrome에서 감지한 최신 m3u8 주소로 다시 시도하세요.")
    for line in text.splitlines():
        if line.strip().startswith(("#EXT-X-KEY:", "#EXT-X-SESSION-KEY:")):
            method = re.search(r'(?:^|,)\s*METHOD=([^,]+)', line.split(":", 1)[1])
            if not method or method[1].strip().strip('"') != "NONE":
                raise MissavError("암호화되거나 DRM으로 보호된 HLS 영상은 지원하지 않습니다.")
    if "#EXTINF:" in text:
        if not re.search(r"(?m)^#EXT-X-ENDLIST\s*$", text):
            raise MissavError("진행 중인 라이브 HLS 영상은 지원하지 않습니다.")
    elif "#EXT-X-STREAM-INF:" not in text and "#EXT-X-MEDIA:" not in text:
        raise MissavError("HLS 재생목록에 다운로드할 영상이 없습니다.")


def is_page(value: str) -> bool:
    try:
        url = urlsplit(value)
        return (url.scheme == "https" and not url.username and not url.password
                and url.port in (None, 443)
                and bool(re.fullmatch(r"(?:[a-z0-9-]+\.)?missav\d*\.[a-z]{2,}", url.hostname or "", re.I)))
    except (ValueError, TypeError):
        return False


def media_id(value: str) -> str | None:
    try:
        url = urlsplit(value)
        first = url.path.split("/")[1]
        if (url.scheme == "https" and not url.username and not url.password and url.port in (None, 443)
                and re.fullmatch(CDN, url.hostname or "", re.I) and re.fullmatch(UUID, first, re.I)):
            return first.lower()
    except (ValueError, TypeError, IndexError):
        pass
    return None


def is_media(value: str) -> bool:
    return media_id(value) is not None and urlsplit(value).path.lower().endswith(".m3u8")


def applies(value: str) -> bool:
    return is_page(value) or is_media(value)


def ordinary_transport(downloader):
    """Keep the pre-MissAV handler set on ordinary jobs, even with cffi installed."""
    if not callable(getattr(downloader, "build_request_director", None)):
        return
    handler = downloader._request_director.handlers.pop("CurlCFFI", None)
    if handler is not None:
        handler.close()


def playlist_urls(text: str) -> list[str]:
    """Prefer explicit player manifests, then narrowly recognized packed/seek data."""
    if len(text) > MAX_PAGE:
        raise MissavError("MissAV 페이지 정보가 처리 한도를 초과했습니다.")
    scripts = re.findall(r"<script\b[^>]*>(.*?)</script\s*>", text, re.I | re.S)
    explicit, inferred = [], []
    for script in scripts[:256]:
        if len(script) > 512 * 1024:
            continue
        script = html.unescape(re.sub(r"\\u002f", "/", script, flags=re.I).replace(r"\/", "/"))
        for match in re.finditer(r"https://[^\s\"'<>\\]{1,2048}\.m3u8(?:\?[^\s\"'<>\\]{0,1024})?", script, re.I):
            if is_media(match[0]):
                explicit.append(match[0])
        for match in re.finditer(r"m3u8\|([0-9a-f|]{36,100})\|com\|(surrit|nineyu|fourhoi)\|https", script, re.I):
            fields = match[1].split("|")[::-1]
            video = "-".join(fields)
            if len(fields) == 5 and re.fullmatch(UUID, video, re.I):
                inferred.append(f"https://{match[2].lower()}.com/{video.lower()}/playlist.m3u8")
        known = list(re.finditer(r"https://(" + CDN + r")/(" + UUID + r")/seek\b", script, re.I))
        for match in known:
            inferred.append(f"https://{match[1].lower()}/{match[2].lower()}/playlist.m3u8")
        if not known and not re.search(CDN, script, re.I):
            for match in re.finditer(r"(" + UUID + r")[^\r\n]{0,100}/seek\b", script, re.I):
                inferred.append(f"https://surrit.com/{match[1].lower()}/playlist.m3u8")
    # A page with several distinct explicit player IDs is ambiguous (often ads).
    # Never guess which one is the user's video.
    result = list(dict.fromkeys(explicit or inferred))
    if len({media_id(url) for url in result}) > 1:
        raise MissavError("페이지에서 여러 영상 주소가 발견됐습니다. Chrome에서 재생 중인 영상의 감지된 m3u8 주소를 붙여 넣으세요.")
    return result[:8]


def configure(downloader, source: str, manifest: str | None = None):
    """Install handlers on this YoutubeDL instance only; never change global handlers."""
    if not applies(source):
        return None
    if importlib.metadata.version("curl-cffi") != "0.16.3":
        raise MissavError("MissAV 통신 구성요소 버전이 맞지 않습니다. 새 데스크톱 ZIP 전체를 압축 해제하세요.")
    import ctypes
    from curl_cffi import Curl, CurlHttpVersion, CurlOpt, ffi, lib, requests
    from yt_dlp.networking._curlcffi import CurlCFFIRH
    from yt_dlp.networking.common import Response
    from yt_dlp.networking.exceptions import RequestError
    from yt_dlp.networking.impersonate import ImpersonateTarget

    page = source if is_page(source) else DEFAULT_PAGE
    origin_parts = urlsplit(page)
    origin = f"{origin_parts.scheme}://{origin_parts.netloc}"
    allowed_id = media_id(source)
    if manifest is not None:
        if not is_media(manifest) or (allowed_id and media_id(manifest) != allowed_id):
            raise MissavError("MissAV 영상의 원본 주소가 일치하지 않습니다.")
        allowed_id = media_id(manifest)
    context = {"id": allowed_id, "page": page}

    class MissavRequestError(RequestError, MissavError):
        pass

    def allowed(address):
        return address == page or (context["id"] is not None and media_id(address) == context["id"])

    class CertificateBlob(ctypes.Structure):
        _fields_ = [("data", ctypes.c_void_p), ("length", ctypes.c_size_t), ("flags", ctypes.c_uint)]

    certificates = {}

    class CertificateCurl(Curl):
        def setopt(self, option, value):
            # curl-cffi encodes CA filenames with the Windows ANSI code page.
            # Read the same trust bundle with Python's Unicode file API and use
            # libcurl's copying CA blob option. TLS checks remain enabled.
            blobs = {CurlOpt.CAINFO: CurlOpt.CAINFO_BLOB, CurlOpt.PROXY_CAINFO: CurlOpt.PROXY_CAINFO_BLOB}
            if self._curl is None or option not in blobs or not isinstance(value, (str, bytes, os.PathLike)):
                return super().setopt(option, value)
            path = os.fspath(value)
            if path not in certificates:
                try:
                    with open(path, "rb") as certificate:
                        data = certificate.read(16 * 1024 * 1024 + 1)
                except OSError:
                    raise MissavError("설정된 TLS 인증서 파일을 읽을 수 없습니다.") from None
                if not data or len(data) > 16 * 1024 * 1024:
                    raise MissavError("설정된 TLS 인증서 파일이 비어 있거나 너무 큽니다.")
                certificates[path] = data
            data = certificates[path]
            buffer = ctypes.create_string_buffer(data)
            blob = CertificateBlob(ctypes.cast(buffer, ctypes.c_void_p), len(data), 1)  # CURL_BLOB_COPY
            result = lib._curl_easy_setopt(self._curl, blobs[option], ffi.cast("void *", ctypes.addressof(blob)))
            self._check_error(result, "set trusted CA contents")
            if option == CurlOpt.CAINFO:
                self._is_cert_set = True
            return result

        def duphandle(self):
            # Streaming requests duplicate the handle before applying options.
            if self._curl is None:
                return super().duphandle()
            return CertificateCurl(cacert=self._cacert, debug=self._debug, handle=lib.curl_easy_duphandle(self._curl))

    class ScopedSession(requests.Session):
        @property
        def curl(self):
            # Keep separate handles for parallel fragment download threads.
            if not getattr(self._local, "curl", None):
                self._local.curl = CertificateCurl(debug=self.debug)
            return self._local.curl

        def request(self, method, url, *args, **kwargs):
            kwargs["allow_redirects"] = False
            for _ in range(6):
                if not allowed(url) or method.upper() != "GET":
                    raise MissavRequestError("MissAV 요청이 선택한 영상의 CDN 범위를 벗어났습니다.")
                response = super().request(method, url, *args, **kwargs)
                if response.status_code not in (301, 302, 303, 307, 308):
                    return response
                location = response.headers.get("Location")
                response.close()
                if not location:
                    raise MissavRequestError("MissAV 서버의 이동 주소가 비어 있습니다.")
                url = urljoin(url, location)
            raise MissavRequestError("MissAV 서버의 주소 이동 횟수가 너무 많습니다.")

    class MissavRH(CurlCFFIRH):
        def _send(self, request):
            response = super()._send(request)
            if is_media(request.url):
                try:
                    data = response.read(MAX_MANIFEST + 1)
                    try:
                        validate_playlist(data)
                    except MissavError as error:
                        context["error"] = str(error)
                        raise MissavRequestError(str(error)) from None
                    return Response(io.BytesIO(data), url=response.url, headers=response.headers,
                                    status=response.status, reason=response.reason, extensions=response.extensions)
                finally:
                    response.close()
            return response

        def _create_instance(self, cookiejar=None):
            options = {CurlOpt.HTTP_VERSION: CurlHttpVersion.V2TLS}
            # Honor an explicitly installed trust bundle, including managed-cloud
            # proxy certificates. Never set verify=False or change the proxy.
            ca = os.environ.get("SSL_CERT_FILE") or os.environ.get("REQUESTS_CA_BUNDLE")
            if ca:
                if not os.path.isfile(ca):
                    raise MissavError("설정된 TLS 인증서 파일을 읽을 수 없습니다.")
                options[CurlOpt.CAINFO] = ca
                options[CurlOpt.PROXY_CAINFO] = ca
            return ScopedSession(curl=CertificateCurl(), cookies=cookiejar, curl_options=options, trust_env=True)

        def _get_impersonate_headers(self, request):
            headers = super()._get_impersonate_headers(request)
            if media_id(request.url):
                headers.update({"Accept": "*/*", "Referer": origin + "/", "Origin": origin,
                                "Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "cross-site"})
            return headers

    downloader.params["impersonate"] = ImpersonateTarget("firefox", "135", "macos", "14")
    previous = downloader.__dict__.pop("_request_director", None)
    if previous is not None:
        previous.close()
    downloader._request_director = downloader.build_request_director([MissavRH])
    return context


def resolve_page(downloader, source: str, context: dict) -> tuple[str, str | None]:
    from yt_dlp.networking import Request
    try:
        with downloader.urlopen(Request(source, headers={"Accept": "text/html"})) as response:
            data = response.read(MAX_PAGE + 1)
    except Exception:
        raise MissavError("MissAV 페이지 인증을 완료할 수 없습니다. Chrome에서 영상을 재생한 뒤 확장의 ‘주소 복사’로 얻은 m3u8 주소를 붙여 넣으세요.") from None
    if len(data) > MAX_PAGE:
        raise MissavError("MissAV 페이지 정보가 처리 한도를 초과했습니다.")
    text = data.decode("utf-8", errors="replace")
    urls = playlist_urls(text)
    if not urls:
        raise MissavError("MissAV 페이지에서 재생 주소를 찾지 못했습니다. Chrome에서 재생 중인 영상의 감지된 m3u8 주소를 붙여 넣으세요.")
    context["id"] = media_id(urls[0])
    title = re.search(r"<title\b[^>]*>(.*?)</title\s*>", text, re.I | re.S)
    return urls[0], html.unescape(re.sub(r"<[^>]+>", "", title[1])).strip()[:200] if title else None
