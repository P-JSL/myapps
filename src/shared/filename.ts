export function safeBasename(input: string): string {
  return (input.split(/[\\/]/).at(-1) ?? 'media').replace(/[\x00-\x1f\x7f<>:"|?*\u202a-\u202e\u2066-\u2069]/g, '_').replace(/[. ]+$/g, '').slice(0, 180) || 'media';
}
