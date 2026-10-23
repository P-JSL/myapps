import { mediaURL } from './model.ts';

interface CopySource { url: string; title: string; }
let fallback: HTMLDialogElement | undefined;
let address: HTMLTextAreaElement;
let opener: HTMLButtonElement | undefined;

function manualCopy(url: string, button: HTMLButtonElement) {
  if (!fallback) {
    fallback = document.createElement('dialog'); fallback.className = 'media-copy-dialog';
    fallback.setAttribute('aria-labelledby', 'media-copy-heading');
    const title = document.createElement('h2'); title.id = 'media-copy-heading'; title.textContent = '미디어 주소 복사';
    const hint = document.createElement('p'); hint.textContent = '자동 복사를 사용할 수 없습니다. 선택된 주소를 Ctrl+C 또는 ⌘C로 복사하세요.';
    address = document.createElement('textarea'); address.readOnly = true; address.rows = 4; address.spellcheck = false;
    address.setAttribute('aria-label', '복사할 미디어 주소');
    const close = document.createElement('button'); close.type = 'button'; close.textContent = '닫기';
    close.addEventListener('click', () => fallback!.close());
    fallback.addEventListener('close', () => { address.value = ''; if (opener?.isConnected && !opener.disabled) opener.focus({ preventScroll: true }); opener = undefined; });
    fallback.append(title, hint, address, close); document.body.append(fallback);
  }
  opener = button; address.value = url;
  if (!fallback.open) fallback.showModal();
  address.focus(); address.select();
}

/** Writes only the explicitly clicked media URL; never reads the clipboard. */
export function mediaCopyButton(source: () => CopySource, report: (message: string) => void): HTMLButtonElement {
  const button = document.createElement('button'); button.type = 'button'; button.textContent = '주소 복사'; button.dataset.action = 'copy-url';
  button.addEventListener('click', event => {
    if (!event.isTrusted || button.disabled) return;
    let url: string;
    try { url = mediaURL(source().url).href; }
    catch { report('미디어 주소를 확인할 수 없어 복사하지 않았습니다.'); return; }
    button.disabled = true;
    const manual = () => { manualCopy(url, button); report('주소를 선택했습니다. 직접 복사해 주세요.'); };
    try {
      if (!navigator.clipboard?.writeText) { manual(); button.disabled = false; return; }
      // Keep this call in the trusted click stack: awaiting anything first may
      // expire browser clipboard activation.
      void navigator.clipboard.writeText(url).then(() => report('미디어 주소를 복사했습니다.'), manual)
        .finally(() => { button.disabled = false; });
    } catch { try { manual(); } finally { button.disabled = false; } }
  });
  button.setAttribute('aria-label', (source().title || '미디어') + ' 주소 복사');
  return button;
}
