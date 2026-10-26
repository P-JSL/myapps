"""Native desktop colors and widget styling for MyVideoApp."""

LIGHT = {
    "background": "#F4F6FA", "surface": "#FFFFFF", "raised": "#F8FAFC",
    "text": "#142238", "muted": "#63748B", "subtle": "#77869A",
    "line": "#E2E8F0", "accent": "#087F8C", "accent_hover": "#066B77",
    "accent_soft": "#E5F4F4", "accent_text": "#096B76", "blue": "#2763CD",
    "success": "#177D57", "success_soft": "#E9F7EF",
    "danger": "#BE3A45", "danger_soft": "#FFF0F0",
    "warning": "#8E630C", "warning_soft": "#FFF7E4", "white": "#FFFFFF",
}

DARK = {
    "background": "#111927", "surface": "#192435", "raised": "#202D40",
    "text": "#EDF3FC", "muted": "#A5B5CA", "subtle": "#91A2BA",
    "line": "#324157", "accent": "#49B8BE", "accent_hover": "#6CCAD0",
    "accent_soft": "#203E48", "accent_text": "#81D6DC", "blue": "#8AB5FF",
    "success": "#78D7AA", "success_soft": "#203D35",
    "danger": "#FF9AA1", "danger_soft": "#452D38",
    "warning": "#F2CC78", "warning_soft": "#413B2A", "white": "#10252B",
}


def stylesheet(dark: bool = False) -> str:
    c = DARK if dark else LIGHT
    return """
    QWidget { color: %(text)s; font-family: "Segoe UI", "Noto Sans CJK KR", "Malgun Gothic", sans-serif; font-size: 14px; }
    QMainWindow, QWidget#MainShell, QStackedWidget, QWidget#Page, QWidget#ScrollBody { background: %(background)s; }
    QFrame#Sidebar { background: %(surface)s; border-right: 1px solid %(line)s; }
    QFrame#SidebarNote { background: %(raised)s; border: 1px solid %(line)s; border-radius: 12px; }
    QFrame#Card, QFrame#JobCard, QFrame#EmptyState { background: %(surface)s; border: 1px solid %(line)s; border-radius: 14px; }
    QFrame#Card:focus-within, QFrame#JobCard:focus-within { border-color: %(accent)s; }
    QFrame#Divider { background: %(line)s; border: none; max-height: 1px; }
    QLabel { background: transparent; border: none; }
    QLabel#Brand { font-size: 18px; font-weight: 700; letter-spacing: -0.5px; }
    QLabel#BrandMeta { color: %(muted)s; font-size: 10px; letter-spacing: 1.3px; font-weight: 600; }
    QLabel#PageTitle { font-size: 28px; font-weight: 700; letter-spacing: -0.8px; }
    QLabel#PageDescription { color: %(muted)s; font-size: 14px; }
    QLabel#SectionTitle { font-size: 17px; font-weight: 700; letter-spacing: -0.3px; }
    QLabel#CardTitle { font-size: 15px; font-weight: 650; }
    QLabel#JobTitle { font-size: 15px; font-weight: 650; }
    QLabel#Muted { color: %(muted)s; font-size: 13px; }
    QLabel#Small { color: %(muted)s; font-size: 12px; }
    QLabel#Eyebrow { color: %(accent_text)s; font-size: 11px; font-weight: 700; letter-spacing: 1.4px; }
    QLabel#FieldLabel { color: %(muted)s; font-size: 12px; font-weight: 600; }
    QLabel#LocalStatus { color: %(success)s; font-size: 12px; font-weight: 600; }
    QLabel#Error { color: %(danger)s; font-size: 13px; }
    QLabel#InlineHint { color: %(muted)s; font-size: 12px; }
    QLabel#Count { color: %(accent_text)s; background: %(accent_soft)s; border-radius: 9px; padding: 2px 8px; font-size: 12px; font-weight: 600; }
    QLabel#Toast { color: %(text)s; background: %(surface)s; border: 1px solid %(line)s; border-radius: 9px; padding: 10px 14px; }
    QPushButton { background: %(surface)s; color: %(text)s; border: 1px solid %(line)s; border-radius: 8px; padding: 9px 14px; font-weight: 600; }
    QPushButton:hover { background: %(raised)s; border-color: %(subtle)s; }
    QPushButton:pressed { background: %(accent_soft)s; }
    QPushButton:focus, QComboBox:focus, QLineEdit:focus, QCheckBox:focus { border: 2px solid %(accent)s; }
    QPushButton:disabled { color: %(subtle)s; background: %(raised)s; border-color: %(line)s; }
    QPushButton#Primary { background: %(accent)s; color: %(white)s; border: 1px solid %(accent)s; font-size: 14px; padding: 12px 22px; font-weight: 700; }
    QPushButton#Primary:hover { background: %(accent_hover)s; border-color: %(accent_hover)s; }
    QPushButton#Primary:focus { border: 2px solid %(text)s; }
    QPushButton#Primary:disabled { background: %(raised)s; color: %(subtle)s; border-color: %(line)s; }
    QPushButton#Nav { border: none; border-radius: 9px; color: %(muted)s; background: transparent; text-align: left; font-size: 14px; padding: 14px 16px; }
    QPushButton#Nav:hover { background: %(raised)s; color: %(text)s; }
    QPushButton#Nav:checked { background: %(accent_soft)s; color: %(accent_text)s; font-weight: 700; }
    QPushButton#Nav:focus { border: 2px solid %(accent)s; }
    QPushButton#TextButton { background: transparent; color: %(accent_text)s; border: none; padding: 5px 7px; font-size: 12px; }
    QPushButton#TextButton:hover { background: %(accent_soft)s; }
    QPushButton#TextButton:focus { border: 2px solid %(accent)s; }
    QPushButton#Quiet { background: transparent; color: %(muted)s; padding: 6px 10px; font-size: 12px; }
    QPushButton#Danger { color: %(danger)s; background: transparent; padding: 6px 10px; font-size: 12px; }
    QPushButton#Danger:hover { background: %(danger_soft)s; border-color: %(danger)s; }
    QPushButton#Filter { border: 1px solid transparent; background: transparent; color: %(muted)s; padding: 7px 12px; font-size: 13px; }
    QPushButton#Filter:checked { border-color: %(line)s; background: %(surface)s; color: %(text)s; }
    QLineEdit { background: %(raised)s; color: %(text)s; border: 1px solid %(line)s; border-radius: 9px; padding: 12px 14px; selection-background-color: %(accent)s; selection-color: %(white)s; font-size: 14px; }
    QLineEdit[error="true"] { border: 1px solid %(danger)s; background: %(danger_soft)s; }
    QLineEdit:read-only { color: %(muted)s; }
    QComboBox { background: %(surface)s; color: %(text)s; border: 1px solid %(line)s; border-radius: 8px; padding: 9px 12px; min-height: 20px; font-size: 13px; }
    QComboBox:hover { border-color: %(subtle)s; }
    QComboBox:disabled { color: %(subtle)s; background: %(raised)s; border-color: %(line)s; }
    QComboBox::drop-down { border: none; width: 28px; }
    QComboBox QAbstractItemView { background: %(surface)s; color: %(text)s; selection-background-color: %(accent_soft)s; selection-color: %(accent_text)s; border: 1px solid %(line)s; padding: 5px; outline: none; }
    QProgressBar { background: %(line)s; border: none; border-radius: 3px; min-height: 6px; max-height: 6px; text-align: center; }
    QProgressBar::chunk { background: %(accent)s; border-radius: 3px; }
    QProgressBar[complete="true"]::chunk { background: %(success)s; }
    QScrollArea { background: transparent; border: none; }
    QScrollBar:vertical { background: transparent; width: 8px; margin: 4px 0; }
    QScrollBar::handle:vertical { background: %(line)s; min-height: 35px; border-radius: 4px; }
    QScrollBar::handle:vertical:hover { background: %(subtle)s; }
    QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical { height: 0; }
    QScrollBar::add-page:vertical, QScrollBar::sub-page:vertical { background: transparent; }
    QCheckBox { spacing: 10px; font-size: 14px; padding: 4px 0; }
    QCheckBox::indicator { width: 18px; height: 18px; border-radius: 5px; border: 1px solid %(subtle)s; background: %(surface)s; }
    QCheckBox::indicator:checked { background: %(accent)s; border: 1px solid %(accent)s; image: none; }
    QCheckBox::indicator:disabled { background: %(line)s; }
    QToolTip { color: %(text)s; background: %(surface)s; border: 1px solid %(line)s; padding: 6px 9px; }
    QMessageBox { background: %(surface)s; }
    QMessageBox QLabel { font-size: 14px; }
    QMenu { background: %(surface)s; color: %(text)s; border: 1px solid %(line)s; padding: 5px; }
    QMenu::item { padding: 8px 20px; }
    QMenu::item:selected { background: %(accent_soft)s; }
    """ % c
