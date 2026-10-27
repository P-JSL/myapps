"""MyVideoApp's native Qt desktop application.

Run ``python desktop/main.py`` for development. The Windows distribution launches
this module with its bundled interpreter; it does not require a Python install.
The interface owns the queue, while engine.py owns downloading and local storage.
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass, field
from datetime import datetime
import json
import os
from pathlib import Path
import sys
import threading
import time
from typing import Any
from urllib.parse import urlsplit
import uuid

# The packaged launcher uses Python's isolated mode. Only this trusted, bundled
# directory is added for sibling modules; the current directory is never used.
DESKTOP_DIR = Path(__file__).resolve().parent
if str(DESKTOP_DIR) not in sys.path:
    sys.path.insert(0, str(DESKTOP_DIR))

from PySide6.QtCore import (
    QLockFile, QObject, QPointF, QRectF, QRunnable, QSize, QStandardPaths, Qt, QThreadPool, QTimer, QUrl, Signal, Slot,
)
from PySide6.QtGui import (
    QAction, QColor, QCloseEvent, QDesktopServices, QDragEnterEvent, QDropEvent,
    QFont, QFontDatabase, QFontMetrics, QIcon, QKeySequence, QPainter, QPainterPath, QPalette,
    QPen, QPixmap, QShortcut,
)
from PySide6.QtWidgets import (
    QApplication, QButtonGroup, QCheckBox, QComboBox, QFileDialog, QFrame,
    QHBoxLayout, QLabel, QLineEdit, QMainWindow, QMessageBox, QPushButton,
    QPlainTextEdit, QScrollArea, QSizePolicy, QSpinBox, QStackedWidget, QVBoxLayout, QWidget,
)

try:
    from .engine import (
        DownloadCancelled, DownloadProgress, DownloadRequest, DownloadResult, Engine, EngineError,
    )
    from .theme import DARK, LIGHT, stylesheet
    from .storage import default_data_dir
    from .activity import ActivityLog
    from .concurrency import (
        MAX_CONCURRENT_DOWNLOADS, MAX_HOST_DOWNLOADS, effective_concurrency,
        normalize_concurrency, normalize_host_concurrency, source_key,
    )
except ImportError:
    from engine import (
        DownloadCancelled, DownloadProgress, DownloadRequest, DownloadResult, Engine, EngineError,
    )
    from theme import DARK, LIGHT, stylesheet
    from storage import default_data_dir
    from activity import ActivityLog
    from concurrency import (
        MAX_CONCURRENT_DOWNLOADS, MAX_HOST_DOWNLOADS, effective_concurrency,
        normalize_concurrency, normalize_host_concurrency, source_key,
    )


VERSION = "1.19.3"
APP_ROOT = Path(__file__).resolve().parent.parent
ACTIVE_STAGES = {"queued", "preparing", "waiting", "downloading", "processing", "scanning"}
STAGE_NAMES = {
    "queued": "대기 중", "preparing": "영상 확인 중", "analyzing": "영상 확인 중",
    "waiting": "작업 대기 중",
    "metadata": "영상 확인 중", "downloading": "다운로드 중", "processing": "파일 정리 중",
    "scanning": "보안 검사 중", "complete": "완료", "completed": "완료",
    "cancelled": "취소됨", "error": "실패", "interrupted": "중단됨", "failed": "실패",
}
_ACTIVITY_EVENT_NAMES = {
    "activity.unknown": "기타 실행 기록", "activity.unavailable": "로그 저장 불가",
    "app.start": "앱 시작", "app.ready": "앱 준비 완료", "app.shutdown": "앱 종료",
    "app.previous_unclean": "이전 실행의 종료 기록 없음", "app.initialization_failed": "앱 초기화 실패",
    "app.event_loop_failed": "앱 실행 오류", "app.unhandled_exception": "처리되지 않은 앱 오류",
    "app.thread_exception": "백그라운드 작업 오류", "queue.add": "다운로드 대기열 추가",
    "queue.cancelled": "대기 중인 다운로드 취소", "queue": "다운로드 대기열 추가",
    "cancel": "다운로드 취소 요청", "retry": "다운로드 재시도 요청", "queued_cancel": "대기 중인 다운로드 취소",
    "download.queued": "다운로드 대기", "download.requested": "다운로드 요청",
    "download.started": "다운로드 시작", "download.retry": "다운로드 재시도",
    "download.retry_requested": "다운로드 재시도 요청", "download.cancel_requested": "다운로드 취소 요청",
    "download.progress": "다운로드 진행", "download.completed": "다운로드 완료",
    "download.cancelled": "다운로드 취소", "download.failed": "다운로드 실패", "download.finished": "다운로드 작업 종료",
    "preparation.begin": "다운로드 준비 시작", "preparation.end": "다운로드 준비 완료",
    "extraction.begin": "영상 정보 확인 시작", "extraction.end": "영상 정보 확인 완료",
    "track.begin": "트랙 수신 시작", "track.end": "트랙 수신 완료", "track.reused": "저장된 트랙 재사용",
    "probe.begin": "미디어 확인 시작", "probe.end": "미디어 확인 완료",
    "processing.begin": "파일 처리 시작", "processing.end": "파일 처리 완료",
    "publish.begin": "최종 파일 저장 시작", "publish.end": "최종 파일 저장 완료",
    "scan.begin": "보안 검사 시작", "scan.end": "보안 검사 완료", "transfer.fallback": "수신 방식 변경",
    "settings.save_failed": "설정 저장 실패", "history.read_failed": "다운로드 기록 읽기 실패",
    "worker.failed": "다운로드 작업 오류", "storage.failed": "로컬 저장소 오류",
    "metadata.requested": "영상 정보 요청", "metadata.completed": "영상 정보 확인 완료",
    "metadata.failed": "영상 정보 확인 실패", "metadata.cancelled": "영상 정보 확인 취소",
}
_ACTIVITY_VALUE_NAMES = {
    "youtube": "YouTube", "direct": "직접 주소", "highest": "최고 화질", "original": "원본",
    "video": "영상", "audio": "오디오", "single": "단일", "parallel": "병렬",
    "convert": "변환", "merge": "병합", "remux": "컨테이너 변경", "success": "성공", "failed": "실패",
    "clean": "정상", "complete": "완료", "cancelled": "취소", "skipped": "생략", "unavailable": "사용 불가",
    "not_supported": "지원되지 않음", "missing_shutdown": "이전 종료 기록 없음", "compatibility": "호환성 처리",
    "requested": "사용자 요청", "validation": "검증", "storage": "저장소", "active": "진행 중",
    "mismatch": "불일치", "unsupported_platform": "지원되지 않는 운영체제", "defender_unavailable": "Defender 사용 불가",
    "add": "추가", "cancel": "취소", "retry": "재시도", "remove": "삭제", "save": "저장",
    "start": "시작", "shutdown": "종료", "extracting": "영상 정보 확인", "probing": "미디어 확인", "publishing": "최종 파일 저장",
    **STAGE_NAMES,
}
_ACTIVITY_DETAIL_NAMES = {
    "error_type": "오류", "http_status": "HTTP", "errno": "OS", "winerror": "Windows",
    "transport_code": "전송 코드", "returncode": "프로세스 코드", "attempt": "시도",
    "source_kind": "종류", "quality": "화질", "output": "형식", "container": "컨테이너", "track_kind": "트랙",
    "transport": "연결", "transfer_mode": "수신", "operation": "처리", "phase": "단계", "outcome": "결과",
    "reason": "사유", "action": "동작", "downloaded": "수신", "total": "전체", "bytes": "크기", "byte_count": "크기",
    "track_index": "트랙 번호", "track_count": "트랙 수", "connections": "연결 수", "count": "개수",
    "active_count": "진행", "queued_count": "대기", "pid": "프로세스", "duration_ms": "소요", "duration": "소요",
    "percent": "진행률", "speed": "속도", "eta": "남은 시간", "delay": "대기 시간", "scan": "보안 검사",
    "retry": "재시도", "reused": "재사용", "resume": "이어받기", "published": "최종 저장", "compatibility_used": "호환성 처리",
}


def _activity_literal(value: Any, limit: int = 80) -> str:
    """Keep one bounded plain-text line even for unfamiliar diagnostic codes."""
    return "".join(character if character.isprintable() else " " for character in str(value))[:limit]


def activity_line(record: dict) -> str:
    """Present safe diagnostic fields without repeating the JSON envelope."""
    try:
        timestamp = datetime.fromisoformat(str(record.get("timestamp", "")).replace("Z", "+00:00"))
        timestamp_text = timestamp.astimezone().strftime("%m-%d %H:%M:%S")
    except (ValueError, TypeError, OSError):
        timestamp_text = "시간 없음"
    level = {"DEBUG": "상세", "INFO": "정보", "WARNING": "주의", "ERROR": "오류", "CRITICAL": "심각"}.get(record.get("level"), "정보")
    event = _activity_literal(record.get("event", "activity.unknown"), 64)
    parts = [f"{timestamp_text} [{level}] {_ACTIVITY_EVENT_NAMES.get(event, event)}"]
    if record.get("job_id"):
        parts.append("작업 " + _activity_literal(record["job_id"], 8))
    elif event in {"app.start", "app.shutdown"} and record.get("session"):
        parts.append("실행 " + _activity_literal(record["session"], 8))
    detail = record.get("detail") if isinstance(record.get("detail"), dict) else {}
    if record.get("stage"):
        stage = _activity_literal(record["stage"], 32)
        parts.append("단계 " + _ACTIVITY_VALUE_NAMES.get(stage, stage))
    for key, title in _ACTIVITY_DETAIL_NAMES.items():
        if key not in detail:
            continue
        value = detail[key]
        if type(value) is bool:
            formatted = "켬" if value else "끔"
        elif type(value) in (int, float):
            formatted = (format_bytes(value) if key in {"downloaded", "total", "bytes", "byte_count"} else
                         format_bytes(value) + "/s" if key == "speed" else
                         f"{value:g} ms" if key == "duration_ms" else f"{value:g}초" if key in {"duration", "eta", "delay"} else
                         f"{value:g}%" if key == "percent" else f"{value:g}")
        else:
            literal = _activity_literal(value)
            formatted = _ACTIVITY_VALUE_NAMES.get(literal, literal)
        parts.append(f"{title} {formatted}")
    trace = detail.get("traceback")
    if isinstance(trace, list) and trace:
        frames = []
        for frame in trace[-2:]:
            if isinstance(frame, dict):
                frames.append(f"{_activity_literal(frame.get('file', ''), 32)}:{_activity_literal(frame.get('line', ''), 8)}"
                              f" {_activity_literal(frame.get('function', ''), 40)}")
        if frames:
            parts.append("위치 " + " ← ".join(frames))
    return " · ".join(parts)


def _activity_emit(activity, event: str, **fields) -> None:
    """Diagnostics must never interrupt a user action or shutdown."""
    if activity is not None:
        try:
            activity.emit(event, **fields)
        except Exception:
            pass


def _activity_exception(activity, event: str, error: BaseException, **fields) -> None:
    if activity is not None:
        try:
            activity.exception(event, error, **fields)
        except Exception:
            pass


class ActivitySession:
    """Own one lifecycle and temporarily preserve the process exception hooks."""
    def __init__(self, activity):
        self.activity = activity
        self.failed = False
        self._closed = False
        self._started = time.monotonic()
        self._sys_hook = sys.excepthook
        self._thread_hook = threading.excepthook

    def start(self):
        try:
            previous = [record for record in self.activity.recent(limit=500)
                        if record.get("session") != self.activity.session_id]
            if previous:
                last_session = previous[-1].get("session")
                if last_session and not any(record.get("event") == "app.shutdown"
                                            and record.get("session") == last_session for record in previous):
                    _activity_emit(self.activity, "app.previous_unclean", level="WARNING", reason="missing_shutdown")
        except Exception:
            pass
        _activity_emit(self.activity, "app.start", pid=os.getpid())
        sys.excepthook = self._unhandled
        threading.excepthook = self._thread_unhandled

    def _unhandled(self, error_type, error, traceback):
        self.capture("app.unhandled_exception", error)
        self._sys_hook(error_type, error, traceback)

    def _thread_unhandled(self, arguments):
        self.capture("app.thread_exception", arguments.exc_value)
        self._thread_hook(arguments)

    def ready(self):
        _activity_emit(self.activity, "app.ready")

    def capture(self, event: str, error: BaseException):
        self.failed = True
        _activity_exception(self.activity, event, error)

    def close(self):
        if self._closed:
            return
        self._closed = True
        sys.excepthook = self._sys_hook
        threading.excepthook = self._thread_hook
        _activity_emit(self.activity, "app.shutdown", outcome="failed" if self.failed else "clean",
                       duration_ms=round((time.monotonic() - self._started) * 1000))
        try:
            self.activity.close()
        except Exception:
            pass


def colors() -> dict[str, str]:
    return DARK if QApplication.instance().property("darkTheme") else LIGHT


def draw_symbol(p: QPainter, name: str, color: str, size: float = 24) -> None:
    """Small, consistent vector icons without platform dependent symbol fonts."""
    p.save()
    p.scale(size / 24, size / 24)
    p.setRenderHint(QPainter.RenderHint.Antialiasing)
    p.setPen(QPen(QColor(color), 1.75, Qt.PenStyle.SolidLine,
                 Qt.PenCapStyle.RoundCap, Qt.PenJoinStyle.RoundJoin))
    p.setBrush(Qt.BrushStyle.NoBrush)

    def line(x1: float, y1: float, x2: float, y2: float) -> None:
        p.drawLine(QPointF(x1, y1), QPointF(x2, y2))

    if name == "download":
        line(12, 3, 12, 15); line(7, 10, 12, 15); line(12, 15, 17, 10)
        path = QPainterPath(QPointF(4, 15)); path.lineTo(4, 20); path.lineTo(20, 20); path.lineTo(20, 15)
        p.drawPath(path)
    elif name == "history":
        p.drawArc(QRectF(4, 4, 16, 16), -30 * 16, 300 * 16)
        line(3, 3, 3, 8); line(3, 8, 8, 8); line(12, 7, 12, 12); line(12, 12, 16, 14)
    elif name == "settings":
        for y, x in ((6, 9), (12, 15), (18, 8)):
            line(4, y, x - 3, y); line(x + 3, y, 20, y)
            p.drawEllipse(QRectF(x - 2.5, y - 2.5, 5, 5))
    elif name == "folder":
        path = QPainterPath(QPointF(3, 6)); path.lineTo(9, 6); path.lineTo(11, 9)
        path.lineTo(21, 9); path.lineTo(20, 19); path.lineTo(3, 19); path.closeSubpath()
        p.drawPath(path); line(3, 10, 20, 10)
    elif name == "clipboard":
        p.drawRoundedRect(QRectF(5, 5, 14, 16), 2, 2)
        p.setBrush(QColor(colors()["surface"]))
        p.drawRoundedRect(QRectF(8, 3, 8, 5), 1.5, 1.5)
        line(9, 12, 15, 12); line(9, 16, 14, 16)
    elif name == "link":
        p.drawArc(QRectF(3, 9, 12, 10), 45 * 16, 270 * 16)
        p.drawArc(QRectF(9, 4, 12, 10), 225 * 16, 270 * 16)
        line(9, 15, 15, 9)
    elif name == "check":
        line(5, 12, 10, 17); line(10, 17, 19, 7)
    elif name == "close":
        line(6, 6, 18, 18); line(6, 18, 18, 6)
    elif name == "search":
        p.drawEllipse(QRectF(4, 4, 12, 12)); line(15, 15, 21, 21)
    elif name == "sun":
        p.drawEllipse(QRectF(8, 8, 8, 8))
        for x1, y1, x2, y2 in ((12, 2, 12, 4), (12, 20, 12, 22), (2, 12, 4, 12),
                               (20, 12, 22, 12), (5, 5, 6.5, 6.5), (17.5, 17.5, 19, 19),
                               (5, 19, 6.5, 17.5), (17.5, 6.5, 19, 5)):
            line(x1, y1, x2, y2)
    elif name == "moon":
        path = QPainterPath(QPointF(19.5, 15.5))
        path.cubicTo(12, 18, 6, 12, 8.5, 4.5)
        path.cubicTo(1, 7, 3, 20.5, 13, 20.5)
        path.cubicTo(16, 20.5, 18.5, 18.5, 19.5, 15.5)
        p.drawPath(path)
    elif name == "shield":
        path = QPainterPath(QPointF(12, 3)); path.lineTo(20, 6); path.lineTo(19, 14)
        path.quadTo(17, 19, 12, 22); path.quadTo(7, 19, 5, 14)
        path.lineTo(4, 6); path.closeSubpath(); p.drawPath(path)
        line(8, 12, 11, 15); line(11, 15, 16, 9)
    elif name == "arrow":
        line(4, 12, 20, 12); line(15, 7, 20, 12); line(20, 12, 15, 17)
    elif name == "chevron":
        line(7, 9, 12, 14); line(12, 14, 17, 9)
    elif name == "play":
        p.drawRoundedRect(QRectF(3, 5, 18, 14), 4, 4)
        path = QPainterPath(QPointF(10, 9)); path.lineTo(15, 12); path.lineTo(10, 15); path.closeSubpath()
        p.drawPath(path)
    elif name == "file":
        path = QPainterPath(QPointF(6, 3)); path.lineTo(14, 3); path.lineTo(19, 8)
        path.lineTo(19, 21); path.lineTo(6, 21); path.closeSubpath(); p.drawPath(path)
        line(14, 3, 14, 8); line(14, 8, 19, 8); line(9, 12, 15, 12); line(9, 16, 15, 16)
    elif name == "refresh":
        p.drawArc(QRectF(4, 4, 16, 16), 45 * 16, 285 * 16)
        line(20, 3, 20, 9); line(15, 9, 20, 9)
    elif name == "monitor":
        p.drawRoundedRect(QRectF(3, 4, 18, 13), 2, 2)
        line(9, 21, 15, 21); line(12, 17, 12, 21)
    elif name == "info":
        p.drawEllipse(QRectF(3, 3, 18, 18)); line(12, 11, 12, 17)
        p.drawPoint(QPointF(12, 7))
    p.restore()


def make_icon(name: str, role: str = "muted", size: int = 20) -> QIcon:
    pixmap = QPixmap(size * 2, size * 2)
    pixmap.setDevicePixelRatio(2)
    pixmap.fill(Qt.GlobalColor.transparent)
    painter = QPainter(pixmap)
    draw_symbol(painter, name, colors().get(role, role), size)
    painter.end()
    return QIcon(pixmap)


class Symbol(QWidget):
    def __init__(self, name: str, size: int = 22, role: str = "muted", tile: bool = False, parent=None):
        super().__init__(parent)
        self.name, self.role, self.tile = name, role, tile
        self.setFixedSize(size, size)
        self.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents)

    def paintEvent(self, event):
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        c = colors()
        if self.tile:
            p.setPen(Qt.PenStyle.NoPen)
            p.setBrush(QColor(c["accent_soft"]))
            p.drawRoundedRect(QRectF(self.rect()), 12, 12)
            s = self.width() * .5
            p.translate((self.width() - s) / 2, (self.height() - s) / 2)
        else:
            s = self.width()
        draw_symbol(p, self.name, c.get(self.role, self.role), s)


class BrandMark(QWidget):
    def __init__(self, size: int = 39, parent=None):
        super().__init__(parent)
        self.setFixedSize(size, size)

    def paintEvent(self, event):
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(QColor("#087F8C"))
        p.drawRoundedRect(QRectF(self.rect()), 11, 11)
        p.translate(8, 8)
        draw_symbol(p, "download", "#FFFFFF", self.width() - 16)


class ElidedLabel(QLabel):
    def __init__(self, text: str = "", name: str = "Muted", parent=None):
        super().__init__(parent)
        self._full_text = text
        self.setObjectName(name)
        self.setTextFormat(Qt.TextFormat.PlainText)
        self.setMinimumWidth(0)
        self.setSizePolicy(QSizePolicy.Policy.Ignored, QSizePolicy.Policy.Preferred)
        self.setToolTip(text)
        self._update_text()

    def setText(self, text: str):
        self._full_text = str(text)
        self.setToolTip(self._full_text)
        self._update_text()

    def resizeEvent(self, event):
        self._update_text()
        super().resizeEvent(event)

    def _update_text(self):
        super().setText(QFontMetrics(self.font()).elidedText(
            self._full_text, Qt.TextElideMode.ElideRight, max(self.width(), 20)))


class ChoiceBox(QComboBox):
    """Keep a clear drop-down affordance in both native color themes."""
    def paintEvent(self, event):
        super().paintEvent(event)
        painter = QPainter(self)
        painter.translate(self.width() - 25, (self.height() - 16) / 2)
        draw_symbol(painter, "chevron", colors()["muted"] if self.isEnabled() else colors()["subtle"], 16)


class ScanSwitch(QCheckBox):
    """An accessible checkbox rendered as an unambiguous on/off switch."""
    def sizeHint(self):
        return QSize(QFontMetrics(self.font()).horizontalAdvance(self.text()) + 64, 36)

    def hitButton(self, position):
        return self.rect().contains(position)

    def paintEvent(self, event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        c = colors()
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(QColor(c["accent"] if self.isChecked() and self.isEnabled() else c["line"]))
        top = (self.height() - 23) / 2
        painter.drawRoundedRect(QRectF(0, top, 42, 23), 11.5, 11.5)
        painter.setBrush(QColor("#FFFFFF" if self.isEnabled() else c["raised"]))
        painter.drawEllipse(QRectF(22 if self.isChecked() else 3, top + 3, 17, 17))
        painter.setPen(QColor(c["text"] if self.isEnabled() else c["muted"]))
        painter.drawText(QRectF(54, 0, self.width() - 54, self.height()), Qt.AlignmentFlag.AlignVCenter, self.text())
        if self.hasFocus():
            painter.setBrush(Qt.BrushStyle.NoBrush)
            painter.setPen(QPen(QColor(c["accent"]), 2))
            painter.drawRoundedRect(QRectF(1, top - 3, 46, 29), 13, 13)


def label(text: str, name: str = "", wrap: bool = False) -> QLabel:
    result = QLabel(text)
    result.setTextFormat(Qt.TextFormat.PlainText)
    result.setObjectName(name)
    result.setWordWrap(wrap)
    return result


def button(text: str, name: str = "", icon: str = "", role: str = "muted") -> QPushButton:
    result = QPushButton(text)
    result.setObjectName(name)
    result.setCursor(Qt.CursorShape.PointingHandCursor)
    if icon:
        result.setProperty("iconName", icon)
        result.setProperty("iconRole", role)
        result.setIcon(make_icon(icon, role))
        result.setIconSize(QSize(18, 18))
    return result


def row(spacing: int = 12) -> QHBoxLayout:
    result = QHBoxLayout()
    result.setContentsMargins(0, 0, 0, 0)
    result.setSpacing(spacing)
    return result


def card_layout(spacing: int = 16, margins: int = 24) -> tuple[QFrame, QVBoxLayout]:
    card = QFrame()
    card.setObjectName("Card")
    layout = QVBoxLayout(card)
    layout.setContentsMargins(margins, margins, margins, margins)
    layout.setSpacing(spacing)
    return card, layout


def format_bytes(number: float | int | None) -> str:
    if number is None:
        return "—"
    value = float(number)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if value < 1024 or unit == "TB":
            return f"{value:.1f} {unit}" if unit != "B" else f"{int(value)} B"
        value /= 1024
    return "—"


def format_eta(seconds: float | int | None) -> str:
    if seconds is None or seconds < 0:
        return "남은 시간 계산 중"
    seconds = int(seconds)
    if seconds < 60:
        return f"약 {seconds}초 남음"
    if seconds < 3600:
        return f"약 {seconds // 60}분 {seconds % 60:02d}초 남음"
    return f"약 {seconds // 3600}시간 {(seconds % 3600) // 60}분 남음"


def source_host(url: str) -> str:
    try:
        host = (urlsplit(url).hostname or "영상 링크").removeprefix("www.")
        return "YouTube" if host in {"youtube.com", "m.youtube.com", "youtu.be"} else host
    except ValueError:
        return "영상 링크"


def short_date(value: Any) -> str:
    if not value:
        return ""
    try:
        if isinstance(value, (float, int)):
            return datetime.fromtimestamp(value).strftime("%Y.%m.%d  %H:%M")
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone().strftime("%Y.%m.%d  %H:%M")
    except (ValueError, TypeError, OSError):
        return str(value)[:16].replace("T", "  ")


class StatusBadge(QLabel):
    def __init__(self, stage: str = "queued", parent=None):
        super().__init__(parent)
        self.setTextFormat(Qt.TextFormat.PlainText)
        self.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.setFixedHeight(25)
        self.setSizePolicy(QSizePolicy.Policy.Fixed, QSizePolicy.Policy.Fixed)
        self.stage = stage
        self.refresh()

    def set_stage(self, stage: str):
        self.stage = stage
        self.refresh()

    def refresh(self):
        c = colors()
        if self.stage in {"complete", "completed"}:
            fg, bg = c["success"], c["success_soft"]
        elif self.stage in {"error", "failed"}:
            fg, bg = c["danger"], c["danger_soft"]
        elif self.stage in {"cancelled", "interrupted", "queued"}:
            fg, bg = c["muted"], c["raised"]
        else:
            fg, bg = c["accent_text"], c["accent_soft"]
        self.setText(STAGE_NAMES.get(self.stage, "준비 중"))
        self.setStyleSheet(f"color:{fg};background:{bg};border:none;border-radius:6px;padding:3px 8px;font-size:11px;font-weight:600;")
        self.adjustSize()


@dataclass
class QueueItem:
    request: DownloadRequest
    job_id: str
    title: str = "영상 정보를 확인하고 있어요"
    stage: str = "queued"
    filepath: str = ""
    message: str = ""
    progress: DownloadProgress | None = None
    cancel: threading.Event = field(default_factory=threading.Event)


class WorkerSignals(QObject):
    progress = Signal(str, object)
    completed = Signal(str, object)
    failed = Signal(str, str, bool)
    done = Signal(str)


class DownloadWorker(QRunnable):
    def __init__(self, engine: Engine, item: QueueItem):
        super().__init__()
        self.engine, self.item = engine, item
        self.signals = WorkerSignals()
        self._progress_lock = threading.Lock()
        self._progress_stage: str | None = None
        self._progress_time = 0.0
        self._progress_percent: float | None = None

    def _emit_progress(self, progress: DownloadProgress):
        # Fragment hooks can arrive much faster than Qt can repaint many cards.
        # Stage changes and the first 100% update still reach the UI immediately.
        with self._progress_lock:
            now = time.monotonic()
            finished = progress.percent is not None and progress.percent >= 100 and (
                self._progress_percent is None or self._progress_percent < 100)
            if progress.stage == self._progress_stage and now - self._progress_time < .1 and not finished:
                return
            self._progress_stage = progress.stage
            self._progress_time = now
            self._progress_percent = progress.percent
            self.signals.progress.emit(self.item.job_id, progress)

    @Slot()
    def run(self):
        try:
            result = self.engine.download(
                self.item.request,
                self._emit_progress,
                self.item.cancel,
            )
            self.signals.completed.emit(self.item.job_id, result)
        except DownloadCancelled as exc:
            self.signals.failed.emit(self.item.job_id, str(exc) or "다운로드를 취소했습니다.", True)
        except EngineError as exc:
            self.signals.failed.emit(self.item.job_id, str(exc), False)
        except Exception as exc:
            _activity_exception(getattr(self.engine, "activity", None), "worker.failed", exc,
                                job_id=self.item.job_id, stage=self.item.stage)
            self.signals.failed.emit(
                self.item.job_id, "다운로드를 완료하지 못했습니다. 저장 폴더와 인터넷 연결을 확인하고 다시 시도하세요.", False)
        finally:
            self.signals.done.emit(self.item.job_id)


class JobCard(QFrame):
    cancel_requested = Signal(str)
    retry_requested = Signal(str)
    folder_requested = Signal(str)

    def __init__(self, item: QueueItem, parent=None):
        super().__init__(parent)
        self.item = item
        self.setObjectName("JobCard")
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Maximum)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(20, 18, 20, 18)
        layout.setSpacing(12)
        heading = row(14)
        self.symbol = Symbol("play", 44, "accent_text", True)
        heading.addWidget(self.symbol)
        titles = QVBoxLayout()
        titles.setSpacing(5)
        self.title = ElidedLabel(item.title, "JobTitle")
        titles.addWidget(self.title)
        self.subtitle = ElidedLabel("", "Small")
        titles.addWidget(self.subtitle)
        heading.addLayout(titles, 1)
        self.badge = StatusBadge(item.stage)
        heading.addWidget(self.badge)
        layout.addLayout(heading)
        from PySide6.QtWidgets import QProgressBar
        self.progress_bar = QProgressBar()
        self.progress_bar.setTextVisible(False)
        self.progress_bar.setRange(0, 1000)
        self.progress_bar.setValue(0)
        layout.addWidget(self.progress_bar)
        self.message_label = label("", "Error", True)
        self.message_label.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        self.message_label.hide()
        layout.addWidget(self.message_label)
        footer = row(8)
        self.stats = ElidedLabel("다운로드 순서를 기다리고 있어요", "Small")
        footer.addWidget(self.stats, 1)
        self.percent = label("", "Small")
        footer.addWidget(self.percent)
        self.saved_folder_button = button("폴더 열기", "Quiet", "folder")
        self.saved_folder_button.setToolTip("이미 저장된 파일이 있는 폴더 열기")
        self.saved_folder_button.clicked.connect(lambda: self.folder_requested.emit(self.item.filepath))
        self.saved_folder_button.hide()
        footer.addWidget(self.saved_folder_button)
        self.action = button("취소", "Quiet", "close")
        self.action.clicked.connect(self._action)
        footer.addWidget(self.action)
        layout.addLayout(footer)
        self.refresh()

    def _action(self):
        if self.item.stage in ACTIVE_STAGES or self.item.stage in {"metadata", "analyzing"}:
            self.cancel_requested.emit(self.item.job_id)
        elif self.item.stage in {"complete", "completed"}:
            self.folder_requested.emit(self.item.filepath or str(self.item.request.folder))
        else:
            self.retry_requested.emit(self.item.job_id)

    def refresh(self):
        item, p = self.item, self.item.progress
        self.title.setText(item.title)
        output = str(item.request.output).upper()
        output = "원본 화질" if output == "ORIGINAL" else output
        quality = "최고 화질" if str(item.request.quality) == "highest" else f"{item.request.quality}p 이하"
        self.subtitle.setText(f"{source_host(item.request.url)}   ·   {output}" + (f"   ·   {quality}" if output not in {"MP3", "M4A"} else "   ·   오디오"))
        self.badge.set_stage(item.stage)
        active = item.stage in ACTIVE_STAGES or item.stage in {"metadata", "analyzing"}
        complete = item.stage in {"complete", "completed"}
        self.saved_folder_button.setVisible(bool(item.filepath) and not active and not complete)
        self.action.setEnabled(not (active and item.cancel.is_set()))
        self.action.setText("취소 중…" if active and item.cancel.is_set() else "취소" if active else "폴더 열기" if complete else "다시 시도")
        icon_name = "close" if active else "folder" if complete else "refresh"
        self.action.setProperty("iconName", icon_name)
        self.action.setIcon(make_icon(icon_name))
        self.progress_bar.setProperty("complete", complete)
        self.progress_bar.style().unpolish(self.progress_bar)
        self.progress_bar.style().polish(self.progress_bar)
        self.progress_bar.setVisible(active or complete)
        self.message_label.setVisible(bool(item.message) and not active)
        if item.message:
            self.message_label.setText(item.message)
            self.message_label.setObjectName("Muted" if complete or item.stage == "cancelled" else "Error")
        if complete:
            self.progress_bar.setRange(0, 1000)
            self.progress_bar.setValue(1000)
            self.percent.setText("100%")
            self.stats.setText(Path(item.filepath).name if item.filepath else "파일을 저장했습니다")
            self.symbol.name = "check"
        elif item.stage == "queued":
            self.progress_bar.setRange(0, 1000)
            self.progress_bar.setValue(0)
            self.percent.setText("")
            self.stats.setText("앞선 작업이 끝나면 자동으로 시작합니다")
        elif not active:
            self.percent.setText("")
            self.stats.setText("필요할 때 같은 옵션으로 다시 시작할 수 있어요")
        elif p:
            percent = getattr(p, "percent", None)
            if percent is not None:
                self.progress_bar.setRange(0, 1000)
                self.progress_bar.setValue(max(0, min(1000, round(float(percent) * 10))))
                self.percent.setText(f"{float(percent):.0f}%")
            else:
                self.progress_bar.setRange(0, 0)
                self.percent.setText("")
            if item.stage == "downloading":
                total, downloaded = getattr(p, "total", None), getattr(p, "downloaded", 0)
                volume = f"{format_bytes(downloaded)} / {format_bytes(total)}" if total else format_bytes(downloaded)
                speed = getattr(p, "speed", None)
                details = {"h2": "HTTP/2", "http/1.1": "HTTP/1.1"}.get(getattr(p, "transport", None), "")
                count = getattr(p, "connections", None)
                mode = getattr(p, "transfer_mode", None)
                if mode == "parallel" and type(count) is int and 1 < count <= 4:
                    details += (" · " if details else "") + f"병렬 요청 {count}개"
                elif mode == "single":
                    details += (" · " if details else "") + "단일 요청"
                stats = ([details] if details else []) + [volume]
                if speed:
                    stats.append(f"{format_bytes(speed)}/s")
                stats.append(format_eta(getattr(p, "eta", None)))
                self.stats.setText("   ·   ".join(stats))
            else:
                self.stats.setText(getattr(p, "message", "") or STAGE_NAMES.get(item.stage, "영상 정보를 확인하고 있어요"))
        else:
            self.progress_bar.setRange(0, 0)
            self.stats.setText("영상 정보와 다운로드할 파일을 확인하고 있어요")
        self.symbol.update()


class MainWindow(QMainWindow):
    def __init__(self, engine: Engine | None = None):
        super().__init__()
        self.engine = engine if engine is not None else Engine(APP_ROOT)
        self.activity = getattr(self.engine, "activity", None)
        self.preferences = self.engine.settings()
        self.dark = self.preferences.get("theme", "light") == "dark"
        app = QApplication.instance()
        app.setProperty("darkTheme", self.dark)
        downloads = QStandardPaths.writableLocation(QStandardPaths.StandardLocation.DownloadLocation) or str(Path.home() / "Downloads")
        self.folder = Path(self.preferences.get("download_folder") or downloads).expanduser().resolve()
        self.folder_confirmed = bool(self.preferences.get("folder_confirmed", False))
        self.concurrency_setting = normalize_concurrency(self.preferences.get("concurrent_downloads"))
        self.concurrency = effective_concurrency(self.concurrency_setting)
        self.host_concurrency = normalize_host_concurrency(self.preferences.get("host_concurrent_downloads"))
        self.items: dict[str, QueueItem] = {}
        self.cards: dict[str, JobCard] = {}
        self.pending: list[str] = []
        self.workers: dict[str, DownloadWorker] = {}
        self.pool = QThreadPool(self)
        self.pool.setMaxThreadCount(MAX_CONCURRENT_DOWNLOADS)
        self._closing = False
        self._history_rows: list[dict] = []
        self.history_filter = "all"
        self.setWindowTitle(f"MyVideoApp {VERSION}")
        self.setMinimumSize(1000, 700)
        self.resize(1220, 860)
        self.setAcceptDrops(True)
        self._build_ui()
        self.apply_theme()
        self._bind_shortcuts()
        self._refresh_history()
        self._refresh_counts()
        self.url_input.setFocus()

    def _build_ui(self):
        shell = QWidget()
        shell.setObjectName("MainShell")
        self.setCentralWidget(shell)
        main = QHBoxLayout(shell)
        main.setContentsMargins(0, 0, 0, 0)
        main.setSpacing(0)
        main.addWidget(self._build_sidebar())
        workspace = QWidget()
        workspace_layout = QVBoxLayout(workspace)
        workspace_layout.setContentsMargins(34, 23, 34, 18)
        workspace_layout.setSpacing(21)
        topbar = row()
        self.breadcrumb = label("내 작업 공간  /  다운로드", "Small")
        topbar.addWidget(self.breadcrumb, 1)
        local_dot = label("●  로컬 앱", "LocalStatus")
        local_dot.setToolTip("파일과 작업 기록은 이 PC에 저장됩니다.")
        topbar.addWidget(local_dot)
        self.theme_button = button("", "Quiet", "moon")
        self.theme_button.setFixedSize(34, 32)
        self.theme_button.setToolTip("화면 테마 바꾸기")
        self.theme_button.setAccessibleName("화면 테마 바꾸기")
        self.theme_button.clicked.connect(self.toggle_theme)
        topbar.addWidget(self.theme_button)
        workspace_layout.addLayout(topbar)
        self.pages = QStackedWidget()
        self.pages.addWidget(self._build_downloads())
        self.pages.addWidget(self._build_history())
        self.pages.addWidget(self._build_settings())
        self.pages.addWidget(self._build_activity())
        self.activity_timer = QTimer(self)
        self.activity_timer.setInterval(2000)
        self.activity_timer.timeout.connect(self._refresh_visible_activity)
        self.pages.currentChanged.connect(self._activity_page_changed)
        workspace_layout.addWidget(self.pages, 1)
        self.toast = label("", "Toast", True)
        self.toast.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        self.toast.hide()
        workspace_layout.addWidget(self.toast)
        self.toast_timer = QTimer(self)
        self.toast_timer.setSingleShot(True)
        self.toast_timer.timeout.connect(self.toast.hide)
        footer = row()
        footer.addWidget(label("MYVIDEOAPP DESKTOP", "BrandMeta"))
        footer.addStretch()
        footer.addWidget(label("내가 고른 영상, 내 PC에.", "Small"))
        workspace_layout.addLayout(footer)
        main.addWidget(workspace, 1)

    def _build_sidebar(self) -> QFrame:
        sidebar = QFrame()
        sidebar.setObjectName("Sidebar")
        sidebar.setFixedWidth(212)
        layout = QVBoxLayout(sidebar)
        layout.setContentsMargins(17, 29, 17, 20)
        layout.setSpacing(8)
        brand = row(10)
        brand.addWidget(BrandMark())
        names = QVBoxLayout()
        names.setSpacing(3)
        names.addWidget(label("MyVideoApp", "Brand"))
        names.addWidget(label(f"DESKTOP · {VERSION}", "BrandMeta"))
        brand.addLayout(names)
        layout.addLayout(brand)
        layout.addSpacing(43)
        self.nav_group = QButtonGroup(self)
        self.nav_group.setExclusive(True)
        self.nav_buttons = []
        for index, (text, icon_name) in enumerate((("다운로드", "download"), ("다운로드 기록", "history"),
                                                  ("설정", "settings"), ("실행 로그", "file"))):
            nav = button(f"  {text}", "Nav", icon_name)
            nav.setCheckable(True)
            nav.setIconSize(QSize(20, 20))
            nav.setMinimumHeight(49)
            self.nav_group.addButton(nav, index)
            layout.addWidget(nav)
            self.nav_buttons.append(nav)
        self.nav_buttons[0].setChecked(True)
        self.nav_group.idClicked.connect(self.navigate)
        layout.addStretch()
        note = QFrame()
        note.setObjectName("SidebarNote")
        note_layout = QVBoxLayout(note)
        note_layout.setContentsMargins(14, 16, 14, 16)
        note_layout.setSpacing(9)
        note_layout.addWidget(Symbol("monitor", 24, "accent_text"))
        note_layout.addWidget(label("내 PC에 차곡차곡", "CardTitle"))
        note_layout.addWidget(label("파일과 다운로드 기록을\n이 PC에서 관리해요.", "Small", True))
        layout.addWidget(note)
        layout.addSpacing(12)
        self.sidebar_folder = button("저장 폴더 열기", "Quiet", "folder")
        self.sidebar_folder.setMinimumHeight(37)
        self.sidebar_folder.clicked.connect(lambda: self.open_folder(str(self.folder)))
        layout.addWidget(self.sidebar_folder)
        return sidebar

    def _scroll_page(self) -> tuple[QScrollArea, QVBoxLayout]:
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        scroll.setFrameShape(QFrame.Shape.NoFrame)
        scroll.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        body = QWidget()
        body.setObjectName("ScrollBody")
        content = QVBoxLayout(body)
        content.setContentsMargins(0, 0, 9, 3)
        content.setSpacing(22)
        scroll.setWidget(body)
        return scroll, content

    def _page_heading(self, layout: QVBoxLayout, title: str, description: str):
        headings = QVBoxLayout()
        headings.setSpacing(9)
        headings.addWidget(label(title, "PageTitle"))
        headings.addWidget(label(description, "PageDescription", True))
        layout.addLayout(headings)

    def _build_downloads(self) -> QWidget:
        page, content = self._scroll_page()
        self.download_scroll = page
        self._page_heading(content, "좋아하는 영상을, 내 PC에.", "영상 주소를 붙여 넣고 원하는 형식으로 간편하게 저장하세요.")
        form, layout = card_layout(19)
        top = row(9)
        top.addWidget(Symbol("link", 20, "accent_text"))
        top.addWidget(label("새 다운로드", "CardTitle"))
        top.addStretch()
        top.addWidget(label("YOUTUBE · 직접 영상 링크", "Eyebrow"))
        layout.addLayout(top)
        address_row = row(9)
        self.url_input = QLineEdit()
        self.url_input.setObjectName("UrlInput")
        self.url_input.setPlaceholderText("https://www.youtube.com/watch?v=…")
        self.url_input.setAccessibleName("다운로드할 영상 주소")
        self.url_input.setClearButtonEnabled(True)
        self.url_input.setMinimumHeight(49)
        self.url_input.returnPressed.connect(self.add_download)
        self.url_input.textEdited.connect(self._clear_url_error)
        address_row.addWidget(self.url_input, 1)
        self.paste_button = button("붙여넣기", "", "clipboard")
        self.paste_button.setMinimumHeight(49)
        self.paste_button.setToolTip("클립보드에서 영상 주소 붙여넣기")
        self.paste_button.clicked.connect(self.paste_url)
        address_row.addWidget(self.paste_button)
        layout.addLayout(address_row)
        options = row(14)
        format_col = QVBoxLayout()
        format_col.setSpacing(7)
        format_col.addWidget(label("저장 형식", "FieldLabel"))
        self.output_combo = ChoiceBox()
        self.output_combo.setAccessibleName("저장 형식")
        for title, value in (("MP4 · 영상", "mp4"), ("WebM · 영상", "webm"), ("MKV · 영상", "mkv"),
                             ("MP3 · 오디오", "mp3"), ("M4A · 오디오", "m4a"), ("원본 형식", "original")):
            self.output_combo.addItem(title, value)
        self.output_combo.setCurrentIndex(max(0, self.output_combo.findData(self.preferences.get("output", "mp4"))))
        self.output_combo.currentIndexChanged.connect(self._option_changed)
        format_col.addWidget(self.output_combo)
        options.addLayout(format_col, 1)
        quality_col = QVBoxLayout()
        quality_col.setSpacing(7)
        quality_col.addWidget(label("영상 화질", "FieldLabel"))
        self.quality_combo = ChoiceBox()
        self.quality_combo.setAccessibleName("영상 화질")
        for title, value in (("제공되는 최고 화질", "highest"), ("4K · 2160p 이하", "2160"),
                             ("2K · 1440p 이하", "1440"), ("Full HD · 1080p 이하", "1080"),
                             ("HD · 720p 이하", "720"), ("SD · 480p 이하", "480")):
            self.quality_combo.addItem(title, value)
        self.quality_combo.setCurrentIndex(max(0, self.quality_combo.findData(str(self.preferences.get("quality", "highest")))))
        self.quality_combo.currentIndexChanged.connect(self._option_changed)
        quality_col.addWidget(self.quality_combo)
        options.addLayout(quality_col, 1)
        download_col = QVBoxLayout()
        download_col.setSpacing(7)
        download_col.addWidget(label(" ", "FieldLabel"))
        self.download_button = button("다운로드 시작", "Primary", "download", "white")
        self.download_button.setMinimumHeight(42)
        self.download_button.clicked.connect(self.add_download)
        download_col.addWidget(self.download_button)
        options.addLayout(download_col)
        layout.addLayout(options)
        divider = QFrame()
        divider.setObjectName("Divider")
        divider.setFixedHeight(1)
        layout.addWidget(divider)
        destination = row(8)
        destination.addWidget(Symbol("folder", 17))
        self.folder_label = ElidedLabel(str(self.folder) if self.folder_confirmed else "첫 다운로드 전에 저장 폴더를 선택해 주세요", "Small")
        destination.addWidget(self.folder_label, 1)
        self.change_folder_button = button("변경" if self.folder_confirmed else "폴더 선택", "TextButton")
        self.change_folder_button.clicked.connect(self.choose_folder)
        destination.addWidget(self.change_folder_button)
        layout.addLayout(destination)
        self.url_hint = label("사이트에서 제공하는 화질로 저장해요. 링크를 이 창에 끌어다 놓아도 됩니다.", "InlineHint", True)
        layout.addWidget(self.url_hint)
        content.addWidget(form)
        queue_heading = row(10)
        queue_heading.addWidget(label("다운로드 목록", "SectionTitle"))
        self.queue_count = label("0", "Count")
        queue_heading.addWidget(self.queue_count)
        queue_heading.addStretch()
        self.clear_queue_button = button("완료 항목 정리", "TextButton")
        self.clear_queue_button.clicked.connect(self.clear_finished)
        self.clear_queue_button.hide()
        queue_heading.addWidget(self.clear_queue_button)
        content.addLayout(queue_heading)
        self.queue_container = QWidget()
        self.queue_layout = QVBoxLayout(self.queue_container)
        self.queue_layout.setContentsMargins(0, 0, 0, 0)
        self.queue_layout.setSpacing(11)
        self.empty_downloads = self._empty_state("download", "첫 번째 영상을 담아 보세요", "영상 주소를 추가하면 여기에서 진행 상황을 확인할 수 있어요.")
        self.queue_layout.addWidget(self.empty_downloads)
        content.addWidget(self.queue_container)
        content.addStretch()
        self._option_changed(save=False)
        return page

    def _empty_state(self, icon_name: str, title: str, description: str) -> QFrame:
        frame = QFrame()
        frame.setObjectName("EmptyState")
        layout = QVBoxLayout(frame)
        layout.setContentsMargins(24, 30, 24, 32)
        layout.setSpacing(10)
        layout.addWidget(Symbol(icon_name, 60, "accent_text", True), alignment=Qt.AlignmentFlag.AlignHCenter)
        layout.addSpacing(4)
        layout.addWidget(label(title, "CardTitle"), alignment=Qt.AlignmentFlag.AlignHCenter)
        text = label(description, "Muted", True)
        text.setAlignment(Qt.AlignmentFlag.AlignCenter)
        layout.addWidget(text)
        return frame

    def _build_history(self) -> QWidget:
        page, content = self._scroll_page()
        self._page_heading(content, "다운로드 기록", "저장한 영상과 이전 작업을 한곳에서 확인하세요.")
        controls = row()
        self.history_search = QLineEdit()
        self.history_search.setPlaceholderText("제목 또는 사이트 검색")
        self.history_search.setAccessibleName("다운로드 기록 검색")
        self.history_search.setClearButtonEnabled(True)
        self.history_search.addAction(make_icon("search"), QLineEdit.ActionPosition.LeadingPosition)
        self.history_search.textChanged.connect(self._render_history)
        controls.addWidget(self.history_search, 1)
        refresh_button = button("새로고침", "", "refresh")
        refresh_button.clicked.connect(self._refresh_history)
        controls.addWidget(refresh_button)
        self.clear_history_button = button("기록 지우기", "Quiet")
        self.clear_history_button.clicked.connect(self.clear_history)
        controls.addWidget(self.clear_history_button)
        content.addLayout(controls)
        filters = row(5)
        self.history_filter_group = QButtonGroup(self)
        self.history_filter_group.setExclusive(True)
        for key, title in (("all", "전체"), ("complete", "완료"), ("stopped", "실패 · 취소")):
            option = button(title, "Filter")
            option.setCheckable(True)
            option.setChecked(key == "all")
            option.clicked.connect(lambda checked=False, k=key: self._set_history_filter(k))
            self.history_filter_group.addButton(option)
            filters.addWidget(option)
        filters.addStretch()
        self.history_count = label("0개 기록", "Small")
        filters.addWidget(self.history_count)
        content.addLayout(filters)
        self.history_container = QWidget()
        self.history_layout = QVBoxLayout(self.history_container)
        self.history_layout.setContentsMargins(0, 0, 0, 0)
        self.history_layout.setSpacing(11)
        content.addWidget(self.history_container)
        content.addStretch()
        return page

    def _build_settings(self) -> QWidget:
        page, content = self._scroll_page()
        self._page_heading(content, "내게 맞는 설정", "저장 위치와 화면을 편하게 맞춰 보세요. 변경 사항은 자동으로 저장됩니다.")
        folder_card, layout = card_layout()
        head = row(10)
        head.addWidget(Symbol("folder", 22, "accent_text"))
        head.addWidget(label("다운로드 저장 위치", "SectionTitle"))
        head.addStretch()
        layout.addLayout(head)
        layout.addWidget(label("새 다운로드를 선택한 폴더에 저장합니다.", "Muted", True))
        folder_row = row(9)
        self.settings_folder = QLineEdit(str(self.folder))
        self.settings_folder.setReadOnly(True)
        self.settings_folder.setAccessibleName("다운로드 저장 폴더 절대경로")
        folder_row.addWidget(self.settings_folder, 1)
        change = button("폴더 선택", "", "folder")
        change.clicked.connect(self.choose_folder)
        folder_row.addWidget(change)
        layout.addLayout(folder_row)
        content.addWidget(folder_card)
        behavior, layout = card_layout(20)
        layout.addWidget(label("화면과 다운로드", "SectionTitle"))
        theme_row = row()
        theme_text = QVBoxLayout()
        theme_text.setSpacing(5)
        theme_text.addWidget(label("화면 테마", "CardTitle"))
        theme_text.addWidget(label("편안한 밝기를 선택하세요.", "Small"))
        theme_row.addLayout(theme_text, 1)
        self.theme_combo = ChoiceBox()
        self.theme_combo.setMinimumWidth(160)
        self.theme_combo.addItem("라이트 모드", "light")
        self.theme_combo.addItem("다크 모드", "dark")
        self.theme_combo.setCurrentIndex(1 if self.dark else 0)
        self.theme_combo.setAccessibleName("화면 테마")
        self.theme_combo.currentIndexChanged.connect(self._theme_changed)
        theme_row.addWidget(self.theme_combo)
        layout.addLayout(theme_row)
        divider = QFrame()
        divider.setObjectName("Divider")
        divider.setFixedHeight(1)
        layout.addWidget(divider)
        queue_row = row()
        queue_text = QVBoxLayout()
        queue_text.setSpacing(5)
        queue_text.addWidget(label("동시 다운로드", "CardTitle"))
        queue_text.addWidget(label("자동으로 개수를 정하거나 최대 16개까지 선택하세요.", "Small"))
        queue_row.addLayout(queue_text, 1)
        self.concurrent_combo = ChoiceBox()
        self.concurrent_combo.setMinimumWidth(160)
        self.concurrent_combo.addItem(f"자동 · {effective_concurrency(0)}개", 0)
        for count in range(1, MAX_CONCURRENT_DOWNLOADS + 1):
            self.concurrent_combo.addItem(f"한 번에 {count}개", count)
        self.concurrent_combo.setCurrentIndex(self.concurrent_combo.findData(self.concurrency_setting))
        self.concurrent_combo.setAccessibleName("동시에 실행할 다운로드 개수")
        self.concurrent_combo.currentIndexChanged.connect(self._concurrency_changed)
        queue_row.addWidget(self.concurrent_combo)
        layout.addLayout(queue_row)
        divider = QFrame()
        divider.setObjectName("Divider")
        divider.setFixedHeight(1)
        layout.addWidget(divider)
        host_row = row()
        host_text = QVBoxLayout()
        host_text.setSpacing(5)
        host_text.addWidget(label("같은 사이트의 동시 다운로드", "CardTitle"))
        self.host_concurrency_hint = label("", "Small", True)
        host_text.addWidget(self.host_concurrency_hint)
        host_row.addLayout(host_text, 1)
        self.host_concurrent_combo = ChoiceBox()
        self.host_concurrent_combo.setMinimumWidth(160)
        for count in range(1, MAX_HOST_DOWNLOADS + 1):
            self.host_concurrent_combo.addItem(f"사이트당 {count}개", count)
        self.host_concurrent_combo.setCurrentIndex(self.host_concurrent_combo.findData(self.host_concurrency))
        self.host_concurrent_combo.setAccessibleName("같은 사이트에서 동시에 실행할 다운로드 개수")
        self.host_concurrent_combo.currentIndexChanged.connect(self._host_concurrency_changed)
        host_row.addWidget(self.host_concurrent_combo)
        layout.addLayout(host_row)
        self._refresh_concurrency_hint()
        divider = QFrame()
        divider.setObjectName("Divider")
        divider.setFixedHeight(1)
        layout.addWidget(divider)
        self.parallel_checkbox = ScanSwitch("파일별 병렬 다운로드")
        self.parallel_checkbox.setChecked(self.preferences.get("parallel_downloads", True) is True)
        self.parallel_checkbox.setAccessibleName("파일별 병렬 다운로드 사용")
        self.parallel_checkbox.toggled.connect(lambda enabled: self._save_preferences(parallel_downloads=enabled))
        layout.addWidget(self.parallel_checkbox)
        layout.addWidget(label("서버가 지원하면 파일 하나를 최대 4개 요청으로 나눠 받습니다. 지원하지 않으면 한 번에 받습니다.", "Small", True))
        divider = QFrame()
        divider.setObjectName("Divider")
        divider.setFixedHeight(1)
        layout.addWidget(divider)
        speed_row = row()
        self.speed_limit_checkbox = ScanSwitch("다운로드 속도 제한")
        self.speed_limit_checkbox.setChecked(self.preferences.get("speed_limit_enabled", False) is True)
        self.speed_limit_checkbox.setAccessibleName("앱 전체 다운로드 속도 제한 사용")
        speed_row.addWidget(self.speed_limit_checkbox, 1)
        self.speed_limit_spin = QSpinBox()
        self.speed_limit_spin.setRange(64, 1048576)
        self.speed_limit_spin.setSuffix(" KiB/s")
        self.speed_limit_spin.setValue(self.preferences.get("speed_limit_kib", 10240))
        self.speed_limit_spin.setMinimumWidth(170)
        self.speed_limit_spin.setEnabled(self.speed_limit_checkbox.isChecked())
        self.speed_limit_spin.setAccessibleName("앱 전체 다운로드 속도 상한 KiB/s")
        self.speed_limit_spin.valueChanged.connect(lambda value: self._save_preferences(speed_limit_kib=value))
        self.speed_limit_checkbox.toggled.connect(self._speed_limit_toggled)
        speed_row.addWidget(self.speed_limit_spin)
        layout.addLayout(speed_row)
        layout.addWidget(label("앱에서 받는 모든 파일의 합산 속도를 제한합니다. 변경 사항은 진행 중인 다운로드에도 바로 적용됩니다. 1 MiB/s = 1024 KiB/s.", "Small", True))
        content.addWidget(behavior)
        scan_card, layout = card_layout()
        head = row(10)
        head.addWidget(Symbol("shield", 22, "accent_text"))
        head.addWidget(label("다운로드 후 보안 검사", "SectionTitle"))
        head.addStretch()
        head.addWidget(label("WINDOWS", "Eyebrow"))
        layout.addLayout(head)
        self.scan_checkbox = ScanSwitch("Microsoft Defender로 저장한 파일 검사")
        self.scan_checkbox.setChecked(bool(self.preferences.get("scan_after_download", sys.platform == "win32")))
        self.scan_checkbox.setEnabled(sys.platform == "win32")
        self.scan_checkbox.toggled.connect(lambda enabled: self._save_preferences(scan_after_download=enabled))
        layout.addWidget(self.scan_checkbox)
        text = "검사를 켜면 다운로드 후 이 PC의 Microsoft Defender를 실행합니다. 검사 결과는 작업에 표시됩니다."
        if sys.platform != "win32":
            text = "Windows에서 Microsoft Defender 검사를 사용할 수 있습니다."
        layout.addWidget(label(text, "Small", True))
        content.addWidget(scan_card)
        about, layout = card_layout()
        about_row = row(15)
        about_row.addWidget(BrandMark(44))
        text = QVBoxLayout()
        text.setSpacing(5)
        text.addWidget(label("MyVideoApp", "SectionTitle"))
        text.addWidget(label(f"버전 {VERSION}  ·  내 PC에서 사용하는 영상 다운로드 앱", "Small", True))
        about_row.addLayout(text, 1)
        layout.addLayout(about_row)
        layout.addWidget(label("YouTube 공개 영상과 지원되는 직접 영상 주소를 저장할 수 있습니다. 본인에게 저장 권한이 있는 콘텐츠를 이용하세요.", "Small", True))
        content.addWidget(about)
        content.addStretch()
        return page

    def _build_activity(self) -> QWidget:
        page = QWidget()
        content = QVBoxLayout(page)
        content.setContentsMargins(0, 0, 0, 0)
        content.setSpacing(16)
        self._page_heading(content, "실행 로그", "앱의 시작과 종료, 다운로드 단계와 오류를 확인하세요.")
        content.addWidget(label("로그는 이 PC에만 약 10 MiB까지 보관됩니다. 서명된 다운로드 주소와 인증 정보는 기록하지 않습니다.", "Small", True))
        self.activity_path = label(str(self.activity.path) if self.activity is not None else "로그 경로를 사용할 수 없습니다.", "Small", True)
        self.activity_path.setAccessibleName("실행 로그 파일 경로")
        self.activity_path.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        content.addWidget(self.activity_path)
        controls = row()
        self.activity_errors_only = QCheckBox("주의·오류만 표시")
        self.activity_errors_only.setAccessibleName("실행 로그 주의·오류만 표시")
        self.activity_errors_only.toggled.connect(self._refresh_activity)
        controls.addWidget(self.activity_errors_only)
        controls.addStretch()
        self.activity_refresh = button("새로고침", "", "refresh")
        self.activity_refresh.clicked.connect(self._refresh_activity)
        controls.addWidget(self.activity_refresh)
        self.activity_copy = button("표시된 로그 복사", "", "clipboard")
        self.activity_copy.setToolTip("현재 필터의 전체 진단 기록을 JSON 형식으로 복사")
        self.activity_copy.clicked.connect(self._copy_activity)
        self.activity_copy.setEnabled(False)
        controls.addWidget(self.activity_copy)
        self.activity_open_folder = button("로그 폴더 열기", "Quiet", "folder")
        self.activity_open_folder.clicked.connect(self._open_activity_folder)
        self.activity_open_folder.setEnabled(self.activity is not None)
        controls.addWidget(self.activity_open_folder)
        content.addLayout(controls)
        self.activity_status = label("실행 로그 페이지를 열면 최근 항목을 표시합니다.", "Small", True)
        self.activity_status.setAccessibleName("실행 로그 저장 상태")
        content.addWidget(self.activity_status)
        self.activity_viewer = QPlainTextEdit()
        self.activity_viewer.setReadOnly(True)
        self.activity_viewer.setFont(QFontDatabase.systemFont(QFontDatabase.SystemFont.FixedFont))
        self.activity_viewer.setMaximumBlockCount(500)
        self.activity_viewer.setLineWrapMode(QPlainTextEdit.LineWrapMode.NoWrap)
        self.activity_viewer.setAccessibleName("최근 실행 로그, 최대 500개")
        self.activity_viewer.setMinimumHeight(230)
        content.addWidget(self.activity_viewer, 1)
        self._activity_records = []
        self._activity_copy_text = ""
        return page

    @Slot()
    def _refresh_activity(self, *_):
        records = []
        read_failed = False
        if self.activity is not None:
            try:
                records = self.activity.recent(limit=500, errors_only=self.activity_errors_only.isChecked())
            except Exception:
                read_failed = True
        self._activity_records = records[-500:]
        # Keep the complete sanitized records for diagnostics, while each visible
        # block leads with the event and its useful operational fields.
        self._activity_copy_text = "\n".join(json.dumps(record, ensure_ascii=False) for record in self._activity_records)
        text = "\n".join(activity_line(record) for record in self._activity_records)
        if text != self.activity_viewer.toPlainText():
            at_end = self.activity_viewer.verticalScrollBar().value() >= self.activity_viewer.verticalScrollBar().maximum()
            self.activity_viewer.setPlainText(text)
            if at_end:
                self.activity_viewer.verticalScrollBar().setValue(self.activity_viewer.verticalScrollBar().maximum())
        self.activity_copy.setEnabled(bool(text))
        unavailable = self.activity is None or not getattr(self.activity, "available", False)
        if unavailable or read_failed:
            failure = getattr(self.activity, "failure", "") if self.activity is not None else ""
            warning = "실행 로그를 저장하거나 읽지 못하고 있습니다. 로컬 저장소의 권한과 디스크 공간을 확인해 주세요."
            self.activity_status.setText(warning + (f" {failure}" if failure else "")
                                         + (f" · 표시 가능한 항목 {len(records)}개" if records else ""))
            self.activity_status.setObjectName("Error")
        else:
            self.activity_status.setText(f"최근 {len(records):,}개 항목 · 최대 500개 표시" if records else
                                         "표시할 주의·오류가 없습니다." if self.activity_errors_only.isChecked() else "아직 실행 로그가 없습니다.")
            self.activity_status.setObjectName("Small")
        self.activity_status.style().unpolish(self.activity_status)
        self.activity_status.style().polish(self.activity_status)

    def _copy_activity(self):
        QApplication.clipboard().setText(self._activity_copy_text)

    def _open_activity_folder(self):
        if self.activity is not None:
            self.open_folder(str(self.activity.directory))

    def _activity_page_changed(self, index: int):
        if index == 3:
            self._refresh_activity()
        self._sync_activity_timer()

    def _sync_activity_timer(self):
        if not hasattr(self, "activity_timer"):
            return
        if self.pages.currentIndex() == 3 and self.isVisible() and not self._closing:
            self.activity_timer.start()
        else:
            self.activity_timer.stop()

    def _refresh_visible_activity(self):
        if self.pages.currentIndex() == 3 and self.isVisible() and not self._closing:
            self._refresh_activity()

    def showEvent(self, event):
        super().showEvent(event)
        self._sync_activity_timer()

    def hideEvent(self, event):
        super().hideEvent(event)
        self._sync_activity_timer()

    def _bind_shortcuts(self):
        self.shortcuts = []
        for key, callback in (("Ctrl+L", self.focus_url), ("Ctrl+,", lambda: self.navigate(2)),
                              ("Alt+1", lambda: self.navigate(0)), ("Alt+2", lambda: self.navigate(1)),
                              ("Alt+3", lambda: self.navigate(2)), ("Alt+4", lambda: self.navigate(3))):
            shortcut = QShortcut(QKeySequence(key), self)
            shortcut.activated.connect(callback)
            self.shortcuts.append(shortcut)

    @Slot(int)
    def navigate(self, index: int):
        self.pages.setCurrentIndex(index)
        self.nav_buttons[index].setChecked(True)
        self.breadcrumb.setText("내 작업 공간  /  " + ("다운로드", "다운로드 기록", "설정", "실행 로그")[index])
        for i, nav in enumerate(self.nav_buttons):
            nav.setIcon(make_icon(nav.property("iconName"), "accent_text" if i == index else "muted"))
        if index == 1:
            self._refresh_history()

    def focus_url(self):
        self.navigate(0)
        self.url_input.setFocus()
        self.url_input.selectAll()

    @Slot()
    def paste_url(self):
        value = QApplication.clipboard().text().strip()
        if not value:
            self.notify("클립보드에 주소가 없습니다. 영상 주소를 복사한 뒤 다시 눌러 주세요.")
            return
        self.url_input.setText(value)
        self._clear_url_error()
        self.focus_url()

    def _clear_url_error(self, *_):
        self.url_input.setProperty("error", False)
        self.url_input.style().unpolish(self.url_input)
        self.url_input.style().polish(self.url_input)
        self.url_hint.setObjectName("InlineHint")
        self.url_hint.setText("사이트에서 제공하는 화질로 저장해요. 링크를 이 창에 끌어다 놓아도 됩니다.")
        self.url_hint.style().unpolish(self.url_hint)
        self.url_hint.style().polish(self.url_hint)

    def _url_error(self, message: str):
        self.url_input.setProperty("error", True)
        self.url_input.style().unpolish(self.url_input)
        self.url_input.style().polish(self.url_input)
        self.url_hint.setObjectName("Error")
        self.url_hint.setText(message)
        self.url_hint.style().unpolish(self.url_hint)
        self.url_hint.style().polish(self.url_hint)
        self.url_input.setFocus()

    @Slot()
    def add_download(self):
        url = self.url_input.text().strip()
        try:
            parsed = urlsplit(url)
            valid = parsed.scheme in {"https", "http"} and bool(parsed.hostname) and not parsed.username and not parsed.password
        except ValueError:
            valid = False
        if not valid:
            self._url_error("http:// 또는 https://로 시작하는 영상 주소를 입력해 주세요.")
            return
        if any(item.request.url == url and item.stage in ACTIVE_STAGES for item in self.items.values()):
            self._url_error("같은 주소를 이미 다운로드하고 있어요. 아래 목록에서 진행 상황을 확인하세요.")
            return
        if not self.folder_confirmed or not self.folder.is_dir():
            if not self.choose_folder():
                return
        self._clear_url_error()
        job_id = uuid.uuid4().hex
        request = DownloadRequest(
            url=url, folder=str(self.folder), quality=str(self.quality_combo.currentData()),
            output=str(self.output_combo.currentData()),
            scan=bool(self.preferences.get("scan_after_download", sys.platform == "win32")) and sys.platform == "win32",
            job_id=job_id,
        )
        self._enqueue(request, job_id)
        self.url_input.clear()

    def _enqueue(self, request: DownloadRequest, job_id: str | None = None):
        job_id = job_id or request.job_id or uuid.uuid4().hex
        if job_id in self.workers or job_id in self.pending:
            self.notify("이미 진행 중인 작업입니다.")
            return
        if job_id in self.cards:
            old = self.cards.pop(job_id)
            self.queue_layout.removeWidget(old)
            old.hide()
            old.deleteLater()
        item = QueueItem(request=request, job_id=job_id)
        self.items[job_id] = item
        widget = JobCard(item)
        widget.cancel_requested.connect(self.cancel_download)
        widget.retry_requested.connect(self.retry_download)
        widget.folder_requested.connect(self.open_folder)
        self.cards[job_id] = widget
        self.queue_layout.addWidget(widget)
        self.pending.append(job_id)
        _activity_emit(self.activity, "queue.add", job_id=job_id, stage="queued", queued_count=len(self.pending))
        self._refresh_counts()
        self._pump_queue()
        QTimer.singleShot(0, lambda: self.download_scroll.ensureWidgetVisible(widget, 0, 18))

    def _pump_queue(self):
        if self._closing:
            return
        # Keep admission in the GUI thread. A cancelled worker retains its slot
        # until done, while queued cancellation never reserves one.
        self.pending[:] = [job_id for job_id in self.pending
                           if job_id in self.items and not self.items[job_id].cancel.is_set()]
        active_by_host: dict[str, int] = {}
        for worker in self.workers.values():
            host = source_key(worker.item.request.url)
            active_by_host[host] = active_by_host.get(host, 0) + 1
        host_limit = min(self.concurrency, self.host_concurrency)
        while self.pending and len(self.workers) < self.concurrency:
            # Prefer the least active eligible source, then its oldest queued
            # item. A busy source at the front cannot block other sources.
            selected_index = None
            selected_host = ""
            selected_count = host_limit
            for index, pending_id in enumerate(self.pending):
                host = source_key(self.items[pending_id].request.url)
                count = active_by_host.get(host, 0)
                if count < selected_count:
                    selected_index, selected_host, selected_count = index, host, count
            if selected_index is None:
                break
            job_id = self.pending.pop(selected_index)
            item = self.items[job_id]
            item.stage = "preparing"
            self.cards[job_id].refresh()
            worker = DownloadWorker(self.engine, item)
            worker.signals.progress.connect(self._on_progress, Qt.ConnectionType.QueuedConnection)
            worker.signals.completed.connect(self._on_completed, Qt.ConnectionType.QueuedConnection)
            worker.signals.failed.connect(self._on_failed, Qt.ConnectionType.QueuedConnection)
            worker.signals.done.connect(self._on_done, Qt.ConnectionType.QueuedConnection)
            self.workers[job_id] = worker
            active_by_host[selected_host] = selected_count + 1
            self.pool.start(worker)
        self._refresh_counts()

    @Slot(str, object)
    def _on_progress(self, job_id: str, progress: DownloadProgress):
        item = self.items.get(job_id)
        if not item:
            return
        item.progress = progress
        item.stage = getattr(progress, "stage", "downloading") or "downloading"
        if getattr(progress, "title", ""):
            item.title = progress.title
        if getattr(progress, "filepath", None):
            item.filepath = str(progress.filepath)
        self.cards[job_id].refresh()
        self._refresh_counts()

    @Slot(str, object)
    def _on_completed(self, job_id: str, result: DownloadResult):
        item = self.items.get(job_id)
        if not item:
            return
        item.title = result.title or item.title
        item.filepath = str(result.filepath)
        item.stage = getattr(result, "status", "complete") or "complete"
        item.message = getattr(result, "message", "")
        self.cards[job_id].refresh()
        notification = QFontMetrics(self.toast.font()).elidedText(
            f"저장 완료 · {item.title}", Qt.TextElideMode.ElideRight, max(400, self.width() - 340))
        self.notify(notification)
        self._refresh_history()

    @Slot(str, str, bool)
    def _on_failed(self, job_id: str, message: str, cancelled: bool):
        item = self.items.get(job_id)
        if not item:
            return
        item.stage = "cancelled" if cancelled else "error"
        item.message = message
        if item.title == "영상 정보를 확인하고 있어요":
            item.title = source_host(item.request.url) + " 다운로드"
        self.cards[job_id].refresh()
        self._refresh_history()

    @Slot(str)
    def _on_done(self, job_id: str):
        self.workers.pop(job_id, None)
        self._refresh_counts()
        if self._closing:
            if not self.workers:
                self.close()
            return
        self._pump_queue()

    @Slot(str)
    def cancel_download(self, job_id: str):
        item = self.items.get(job_id)
        if not item or item.cancel.is_set():
            return
        queued = job_id in self.pending
        _activity_emit(self.activity, "queue.cancelled" if queued else "download.cancel_requested",
                       job_id=job_id, stage=item.stage)
        item.cancel.set()
        if queued:
            self.pending.remove(job_id)
            item.stage = "cancelled"
            item.message = "시작하기 전에 취소했습니다."
        self.cards[job_id].refresh()
        self._refresh_counts()

    @Slot(str)
    def retry_download(self, job_id: str):
        _activity_emit(self.activity, "download.retry_requested", job_id=job_id)
        try:
            item = self.items.get(job_id)
            if item:
                original = item.request
                request = DownloadRequest(
                    url=original.url, folder=original.folder, quality=original.quality,
                    output=original.output, scan=original.scan, job_id=job_id,
                )
            else:
                request = self.engine.retry_request(job_id)
            self._enqueue(request, request.job_id or job_id)
            self.navigate(0)
        except (EngineError, ValueError) as exc:
            self.notify(str(exc) or "새 영상 주소를 입력한 뒤 다시 시작해 주세요.")
            self.focus_url()
        except Exception as exc:
            _activity_exception(self.activity, "worker.failed", exc, job_id=job_id, action="retry")
            self.notify("기록의 주소로 다시 시작할 수 없습니다. 새 영상 주소를 입력해 주세요.")
            self.focus_url()

    def _refresh_counts(self):
        count = len(self.pending) + len(self.workers)
        self.queue_count.setText(str(count) if count else str(len(self.items)))
        self.empty_downloads.setVisible(not self.items)
        self.clear_queue_button.setVisible(any(key not in self.workers and key not in self.pending for key in self.items))
        self.nav_buttons[0].setText(f"  다운로드  ·  {count}" if count else "  다운로드")

    @Slot()
    def clear_finished(self):
        for job_id in list(self.items):
            if job_id in self.workers or job_id in self.pending:
                continue
            self.items.pop(job_id)
            card = self.cards.pop(job_id)
            self.queue_layout.removeWidget(card)
            card.hide()
            card.deleteLater()
        self._refresh_counts()

    @Slot()
    def choose_folder(self) -> bool:
        selected = QFileDialog.getExistingDirectory(self, "다운로드 저장 폴더 선택", str(self.folder))
        if not selected:
            return False
        selected_path = Path(selected).expanduser().resolve()
        if not selected_path.is_dir() or not os.access(selected_path, os.W_OK):
            self.notify("이 폴더에 파일을 저장할 수 없습니다. 쓰기 가능한 폴더를 선택해 주세요.")
            return False
        self.folder = selected_path
        self.folder_confirmed = True
        self.folder_label.setText(str(self.folder))
        self.change_folder_button.setText("변경")
        self.settings_folder.setText(str(self.folder))
        self._save_preferences(download_folder=str(self.folder), folder_confirmed=True)
        self.notify("새 다운로드의 저장 폴더를 변경했습니다.")
        return True

    @Slot(str)
    def open_folder(self, path: str):
        target = Path(path).expanduser()
        if target.is_file():
            target = target.parent
        if not target.exists():
            self.notify("폴더를 찾을 수 없습니다. 파일이 이동되었는지 확인해 주세요.")
            return
        if not QDesktopServices.openUrl(QUrl.fromLocalFile(str(target.resolve()))):
            self.notify("폴더를 열 수 없습니다. 설정에서 저장 위치를 확인해 주세요.")

    def _option_changed(self, *_, save: bool = True):
        if not hasattr(self, "quality_combo"):
            return
        self.quality_combo.setEnabled(self.output_combo.currentData() not in {"mp3", "m4a"})
        if save:
            self._save_preferences(output=self.output_combo.currentData(), quality=self.quality_combo.currentData())

    def _save_preferences(self, **values):
        self.preferences.update(values)
        try:
            self.engine.save_settings(values)
        except Exception as exc:
            _activity_exception(self.activity, "settings.save_failed", exc)
            if hasattr(self, "toast"):
                self.notify("설정을 저장하지 못했습니다. 앱의 저장 공간을 확인해 주세요.")

    def _speed_limit_toggled(self, enabled):
        self.speed_limit_spin.setEnabled(enabled)
        self._save_preferences(speed_limit_enabled=enabled)

    def apply_theme(self):
        app = QApplication.instance()
        app.setProperty("darkTheme", self.dark)
        app.setStyleSheet(stylesheet(self.dark))
        c = colors()
        palette = app.palette()
        for role, value in ((QPalette.ColorRole.Window, c["background"]),
                            (QPalette.ColorRole.WindowText, c["text"]),
                            (QPalette.ColorRole.Base, c["surface"]),
                            (QPalette.ColorRole.AlternateBase, c["raised"]),
                            (QPalette.ColorRole.Text, c["text"]),
                            (QPalette.ColorRole.PlaceholderText, c["muted"]),
                            (QPalette.ColorRole.Button, c["surface"]),
                            (QPalette.ColorRole.ButtonText, c["text"]),
                            (QPalette.ColorRole.Highlight, c["accent"]),
                            (QPalette.ColorRole.HighlightedText, c["white"])):
            palette.setColor(role, QColor(value))
        app.setPalette(palette)
        self.activity_viewer.setStyleSheet(
            f"QPlainTextEdit {{ background:{c['surface']}; color:{c['text']}; "
            f"border:1px solid {c['line']}; border-radius:8px; padding:8px; "
            f"selection-background-color:{c['accent']}; selection-color:{c['white']}; }}")
        for widget in self.findChildren(QPushButton):
            name = widget.property("iconName")
            if name:
                role = widget.property("iconRole") or "muted"
                widget.setIcon(make_icon(name, role))
        self.theme_button.setProperty("iconName", "sun" if self.dark else "moon")
        self.theme_button.setIcon(make_icon("sun" if self.dark else "moon"))
        self.theme_button.setToolTip("라이트 모드로 바꾸기" if self.dark else "다크 모드로 바꾸기")
        for widget in self.findChildren(Symbol):
            widget.update()
        for badge in self.findChildren(StatusBadge):
            badge.refresh()
        for job in self.cards.values():
            job.refresh()
        for i, nav in enumerate(self.nav_buttons):
            nav.setIcon(make_icon(nav.property("iconName"), "accent_text" if self.pages.currentIndex() == i else "muted"))
        self.setWindowIcon(make_icon("download", "accent", 48))

    @Slot()
    def toggle_theme(self):
        self.theme_combo.setCurrentIndex(0 if self.dark else 1)

    def _theme_changed(self, index: int):
        self.dark = index == 1
        self.apply_theme()
        self._save_preferences(theme="dark" if self.dark else "light")

    def _concurrency_changed(self, *_):
        self.concurrency_setting = normalize_concurrency(self.concurrent_combo.currentData())
        self.concurrency = effective_concurrency(self.concurrency_setting)
        self._save_preferences(concurrent_downloads=self.concurrency_setting)
        self._refresh_concurrency_hint()
        self._pump_queue()

    def _host_concurrency_changed(self, *_):
        self.host_concurrency = normalize_host_concurrency(self.host_concurrent_combo.currentData())
        self._save_preferences(host_concurrent_downloads=self.host_concurrency)
        self._refresh_concurrency_hint()
        self._pump_queue()

    def _refresh_concurrency_hint(self):
        limit = min(self.concurrency, self.host_concurrency)
        self.host_concurrency_hint.setText(f"현재 사이트당 최대 {limit}개 · YouTube 주소는 하나의 사이트로 계산해요.")

    @Slot()
    def _refresh_history(self):
        try:
            self._history_rows = self.engine.history()
        except Exception as exc:
            _activity_exception(self.activity, "history.read_failed", exc)
            self._history_rows = []
            if hasattr(self, "toast"):
                self.notify("다운로드 기록을 불러오지 못했습니다. 잠시 후 새로고침해 주세요.")
        self._render_history()

    def _set_history_filter(self, key: str):
        self.history_filter = key
        self._render_history()

    def _render_history(self, *_):
        if not hasattr(self, "history_layout"):
            return
        while self.history_layout.count():
            item = self.history_layout.takeAt(0)
            if item.widget():
                item.widget().hide()
                item.widget().deleteLater()
        search = self.history_search.text().strip().casefold()
        filtered = []
        for record in self._history_rows:
            stage = record.get("stage", record.get("status", "error"))
            if self.history_filter == "complete" and stage not in {"complete", "completed"}:
                continue
            if self.history_filter == "stopped" and stage not in {"error", "failed", "cancelled", "interrupted"}:
                continue
            if search and search not in (str(record.get("title", "")) + " " + str(record.get("url", ""))).casefold():
                continue
            filtered.append(record)
        self.history_count.setText(f"{len(filtered):,}개 기록")
        self.clear_history_button.setEnabled(bool(self._history_rows))
        if not filtered:
            title = "검색 결과가 없습니다" if search else "아직 다운로드 기록이 없어요"
            desc = "다른 제목이나 사이트 이름으로 검색해 보세요." if search else "다운로드를 시작하면 작업 기록이 여기에 남습니다."
            self.history_layout.addWidget(self._empty_state("search" if search else "history", title, desc))
            return
        for record in filtered[:150]:
            self.history_layout.addWidget(self._history_card(record))
        if len(filtered) > 150:
            self.history_layout.addWidget(label("최근 150개를 표시하고 있어요. 검색으로 원하는 기록을 찾아보세요.", "Small", True))

    def _history_card(self, record: dict) -> QFrame:
        frame, layout = card_layout(12, 19)
        stage = record.get("stage", record.get("status", "error"))
        complete = stage in {"complete", "completed"}
        header = row(13)
        header.addWidget(Symbol("check" if complete else "file", 42, "accent_text", True))
        titles = QVBoxLayout()
        titles.setSpacing(6)
        titles.addWidget(ElidedLabel(record.get("title") or source_host(record.get("url", "")) + " 다운로드", "JobTitle"))
        date = short_date(record.get("created_at"))
        output = str(record.get("output", "")).upper().replace("ORIGINAL", "원본")
        titles.addWidget(ElidedLabel("   ·   ".join(filter(None, (source_host(record.get("url", "")), output, date))), "Small"))
        header.addLayout(titles, 1)
        header.addWidget(StatusBadge(stage))
        layout.addLayout(header)
        message = record.get("message", "")
        if message and stage in {"error", "failed", "interrupted"}:
            detail = label(str(message), "Error", True)
            detail.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
            layout.addWidget(detail)
        actions = row(8)
        actions.addWidget(ElidedLabel(record.get("filepath") or record.get("url", ""), "Small"), 1)
        if complete or record.get("filepath"):
            open_button = button("폴더 열기", "Quiet", "folder")
            open_button.clicked.connect(lambda checked=False, p=record.get("filepath") or record.get("folder", ""): self.open_folder(p))
            actions.addWidget(open_button)
        if not complete and stage not in ACTIVE_STAGES:
            retry = button("다시 시도", "Quiet", "refresh")
            retry.clicked.connect(lambda checked=False, key=str(record.get("job_id", "")): self.retry_download(key))
            actions.addWidget(retry)
        layout.addLayout(actions)
        return frame

    @Slot()
    def clear_history(self):
        if not self._history_rows:
            return
        choice = QMessageBox.question(self, "다운로드 기록 지우기", "완료·실패·취소한 작업 기록을 지울까요?\n저장한 파일은 그대로 유지됩니다.",
                                      QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
                                      QMessageBox.StandardButton.No)
        if choice != QMessageBox.StandardButton.Yes:
            return
        try:
            active_ids = set(self.workers) | set(self.pending)
            for record in self._history_rows:
                job_id = str(record.get("job_id", ""))
                if job_id not in active_ids and record.get("stage") not in ACTIVE_STAGES:
                    self.engine.remove_history(job_id)
            self._refresh_history()
            self.notify("작업 기록을 지웠습니다. 저장한 파일은 그대로 유지됩니다.")
        except Exception:
            self.notify("일부 기록을 지우지 못했습니다. 잠시 후 다시 시도해 주세요.")

    def notify(self, message: str):
        self.toast.setText(message[:600])
        self.toast.show()
        self.toast_timer.start(6500)

    def dragEnterEvent(self, event: QDragEnterEvent):
        if event.mimeData().hasText() or event.mimeData().hasUrls():
            event.acceptProposedAction()

    def dropEvent(self, event: QDropEvent):
        urls = event.mimeData().urls()
        text = urls[0].toString() if urls else event.mimeData().text().strip()
        self.url_input.setText(text)
        self._clear_url_error()
        self.focus_url()
        event.acceptProposedAction()

    def closeEvent(self, event: QCloseEvent):
        if self.workers and not self._closing:
            dialog = QMessageBox(self)
            dialog.setWindowTitle("다운로드가 진행 중입니다")
            dialog.setText("진행 중인 다운로드를 취소하고 종료할까요?")
            dialog.setInformativeText("완료된 파일은 유지됩니다. 작업을 정리한 뒤 앱을 닫습니다.")
            stop = dialog.addButton("취소 후 종료", QMessageBox.ButtonRole.DestructiveRole)
            keep = dialog.addButton("계속 다운로드", QMessageBox.ButtonRole.RejectRole)
            dialog.setDefaultButton(keep)
            dialog.exec()
            if dialog.clickedButton() != stop:
                event.ignore()
                return
            self.cancel_for_shutdown()
            self.notify("진행 중인 작업을 정리하고 있습니다. 잠시 후 자동으로 종료됩니다.")
            self.setEnabled(False)
            event.ignore()
            return
        if self._closing and self.workers:
            event.ignore()
            return
        self.cancel_for_shutdown()
        event.accept()

    def cancel_for_shutdown(self):
        """Also runs for app.quit(), which bypasses the window close dialog."""
        self._closing = True
        self.activity_timer.stop()
        for job_id in list(self.pending) + list(self.workers):
            self.cancel_download(job_id)
        self.pending.clear()


def acquire_app_lock(data_dir: Path | None = None) -> QLockFile | None:
    """Hold one desktop instance per local store, before SQLite reconciliation.

    Return None when another live instance owns the store. Disabling time based
    expiry preserves long downloads; Qt still checks whether the owning PID died.
    The caller must retain the returned object for the application's lifetime.
    """
    directory = Path(data_dir if data_dir is not None else default_data_dir()).expanduser().resolve()
    directory.mkdir(parents=True, exist_ok=True)
    lock = QLockFile(str(directory / "desktop.instance.lock"))
    lock.setStaleLockTime(0)
    if lock.tryLock(0):
        return lock
    if lock.error() == QLockFile.LockError.LockFailedError:
        return None
    raise OSError("앱 실행 상태를 확인할 수 없습니다. 로컬 저장소의 쓰기 권한을 확인해 주세요.")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="MyVideoApp desktop")
    parser.add_argument("--smoke-test", action="store_true", help="Open the native UI and exit without downloading")
    parser.add_argument("--screenshot", type=Path, help="Save a window screenshot (for development verification)")
    parser.add_argument("--data-dir", type=Path, help="Use a separate local data directory (for development verification)")
    args = parser.parse_args(argv)
    app = QApplication(sys.argv[:1])
    app.setApplicationName("MyVideoApp")
    app.setApplicationDisplayName("MyVideoApp")
    app.setApplicationVersion(VERSION)
    app.setOrganizationName("MyVideoApp")
    app.setStyle("Fusion")
    font = QFont("Segoe UI" if sys.platform == "win32" else "Noto Sans CJK KR")
    font.setPointSize(10)
    app.setFont(font)
    instance_lock = None
    session = None
    window = None
    try:
        data_dir = Path(args.data_dir if args.data_dir is not None else default_data_dir()).expanduser().resolve()
        instance_lock = acquire_app_lock(data_dir)
        if instance_lock is None:
            QMessageBox.information(None, "MyVideoApp가 실행 중입니다", "MyVideoApp가 이미 실행 중입니다.\n작업 표시줄에서 열려 있는 앱 창을 확인해 주세요.")
            return 0
        # Rotation and retained-session inspection begin only after ownership of
        # the local store is established. A second instance never opens a writer.
        activity = ActivityLog(data_dir, version=VERSION)
        session = ActivitySession(activity)
        session.start()
        window = MainWindow(Engine(APP_ROOT, data_dir=data_dir, activity=activity))
    except Exception as exc:
        if session is not None:
            session.capture("app.initialization_failed", exc)
            session.close()
        if instance_lock is not None:
            instance_lock.unlock()
        if args.smoke_test:
            print(f"Unable to initialize desktop application ({type(exc).__name__}).", file=sys.stderr)
            return 1
        QMessageBox.critical(None, "MyVideoApp를 시작할 수 없습니다", "앱의 로컬 저장소 또는 구성 파일을 준비할 수 없습니다.\n앱 폴더의 쓰기 권한과 디스크 공간을 확인해 주세요.")
        return 1
    try:
        window.show()
        app.aboutToQuit.connect(window.cancel_for_shutdown)
        session.ready()
        if args.screenshot:
            def capture():
                args.screenshot.parent.mkdir(parents=True, exist_ok=True)
                window.grab().save(str(args.screenshot))
            QTimer.singleShot(500, capture)
        if args.smoke_test:
            QTimer.singleShot(1000, app.quit)
        return app.exec()
    except Exception as exc:
        session.capture("app.event_loop_failed", exc)
        if args.smoke_test:
            print(f"Desktop event loop failed ({type(exc).__name__}).", file=sys.stderr)
        else:
            QMessageBox.critical(None, "MyVideoApp 실행 오류", "앱 실행 중 오류가 발생했습니다. 실행 로그를 확인한 뒤 다시 시작해 주세요.")
        return 1
    finally:
        window.cancel_for_shutdown()
        if window.workers:
            # app.quit() and an exceptional event-loop exit bypass the normal
            # close callbacks. Keep both the store lock and writer until every
            # cancelled worker has emitted its final activity records.
            window.pool.waitForDone()
        session.close()
        instance_lock.unlock()


if __name__ == "__main__":
    raise SystemExit(main())
