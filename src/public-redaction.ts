const SECRET_PATTERNS: RegExp[] = [
  /raw\s*chain\s*of\s*thought/gi,
  /rawChainOfThought/g,
  /(?:raw\s*)?chain[-_\s]?of[-_\s]?thought/gi,
  /\bcot\b/gi,
  /hidden reasoning/gi,
  /oauth[_-\s]?token(?:\s*(?:=|:)\s*|\s+)[A-Za-z0-9._/-]+/gi,
  /session(?:[_-\s]?token|\s+cookie)(?:\s*(?:=|:)\s*|\s+)[A-Za-z0-9._/-]+/gi,
  /(?:api\s*)?csrf(?:[_-\s]?token)?(?:\s*(?:=|:)\s*|\s+)[A-Za-z0-9._/-]+/gi,
  /(?:agentoj[_-\s]*)?(?:trusted[_-\s]*)?proxy[_-\s]*secret(?:\s*(?:=|:)\s*|\s+)[A-Za-z0-9._/-]+/gi,
  /AGENTOJ_[A-Z0-9_]*(?:SECRET|TOKEN)[A-Z0-9_]*\s*=\s*[A-Za-z0-9._/-]+/g,
  /[A-Z][A-Z0-9_]*(?:SECRET|TOKEN|API_KEY|ACCESS_KEY|DATABASE_URL|URL|KEY)[A-Z0-9_]*\s*=\s*\S+/g,
  /authorization\s*:\s*bearer\s+[A-Za-z0-9._~+/-]+/gi,
  /\b(?:secret|token|api[_-\s]?key|access[_-\s]?token|refresh[_-\s]?token)\s*(?:=|:)\s*[A-Za-z0-9._~+/-]+/gi,
  /\b(?:oracle(?:[-_\s]?(?:path|file|dir|directory|descriptor))?|hidden[-_\s]?case|test[-_\s]?case|result[-_\s]?bundle|api[-_\s]?origin|container[-_\s]?(?:id|name|path))\s*(?:=|:)\s*\S+/gi,
  /\b(?:\/[A-Za-z0-9._-]+)+(?:\/(?:oracle|hidden|cases?|result[-_]?bundle|container)[A-Za-z0-9._-]*)+\b/gi,
  /(?:^|\s)\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+/g,
  /oauth[_-]?token/gi,
  /session[_-]?token/gi,
  /csrf[-_]?token/gi,
  /edge[-_]?secret/gi,
  /\b(?:\/[A-Za-z0-9._-]+)+\/[A-Za-z0-9._-]*\.sqlite\b/g,
  /\b[A-Za-z0-9._-]+\.sqlite\b/gi,
  /\b(?:stdout|stderr)\b/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  /\bhttps?:\/\/[^/\s:@]+:[^/\s@]+@[^/\s]+/gi,
  /\b(?:oracle(?:[-_\s]?(?:path|file|dir|directory|descriptor))?|hidden[-_\s]?case|test[-_\s]?case|result[-_\s]?bundle|api[-_\s]?origin|container[-_\s]?(?:id|name|path))\s*(?:=|:)\s*\S+/gi,
  /\b(?:\/[A-Za-z0-9._-]+)+(?:\/(?:oracle|hidden|cases?|result[-_]?bundle|container)[A-Za-z0-9._-]*)+\b/gi,
  /\b(?:secret|token|key)[-_\s:=>&quot;']+(?:[A-Za-z0-9._~+/-]{12,}|[a-f0-9]{16,})\b/gi,
  /\b(?:s(?:\\?[\s*_`<>()\[\]{}.-]|&[#a-z0-9]+;|%[0-9a-f]{2})*e(?:\\?[\s*_`<>()\[\]{}.-]|&[#a-z0-9]+;|%[0-9a-f]{2})*c(?:\\?[\s*_`<>()\[\]{}.-]|&[#a-z0-9]+;|%[0-9a-f]{2})*r(?:\\?[\s*_`<>()\[\]{}.-]|&[#a-z0-9]+;|%[0-9a-f]{2})*e(?:\\?[\s*_`<>()\[\]{}.-]|&[#a-z0-9]+;|%[0-9a-f]{2})*t|t(?:\\?[\s*_`<>()\[\]{}.-]|&[#a-z0-9]+;|%[0-9a-f]{2})*o(?:\\?[\s*_`<>()\[\]{}.-]|&[#a-z0-9]+;|%[0-9a-f]{2})*k(?:\\?[\s*_`<>()\[\]{}.-]|&[#a-z0-9]+;|%[0-9a-f]{2})*e(?:\\?[\s*_`<>()\[\]{}.-]|&[#a-z0-9]+;|%[0-9a-f]{2})*n)\s*(?:=|:|&equals;)\s*\S+/gi,
  /s&#(?:101|x65);cret\s*(?:=|:|&equals;)\s*\S+/gi,
  /t&#(?:111|x6f);ken\s*(?:=|:|&equals;)\s*\S+/gi,
];

const PATCH_LINE_PATTERN = /^(?:diff --git|index [0-9a-f]+|---\s|\+\+\+\s|@@\s|[+-].+|\s*return\s+.*SHOULD_NOT_LEAK|.*SHOULD_NOT_LEAK_PATCH.*)$/i;
const INLINE_PATCH_PATTERNS: RegExp[] = [
  /diff --git/gi,
  /SHOULD_NOT_LEAK_PATCH/g,
  /return\s+xs\[0\]/g,
  /return\s+missing/g,
  /return\s+text\[::-1\]/g,
  /[+-]\s+(?:leaked_line|removed_line)/gi,
];

const MARKDOWN_ESCAPE_PATTERN = /([\\`*_{}\[\]<>()#+.!|>-])/g;

export function escapePublicMarkdown(value: string): string {
  return value.replace(MARKDOWN_ESCAPE_PATTERN, "\\$1");
}

export function redactPublicMarkdown(value: string): string {
  return escapePublicMarkdown(redactPublicText(value));
}

export function assertPublicPayloadSafe(value: unknown, context: string): void {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error(`Invalid public payload: ${context}`);
  if (redactPublicText(encoded) !== encoded) {
    throw new Error(`Unsafe public payload: ${context}`);
  }
}

export function isPublicSlug(value: string): boolean {
  return /^\/recordings\/[A-Za-z0-9._-]+$/.test(value);
}
export function redactPublicText(value: string): string {
  let redacted = value;
  for (const pattern of SECRET_PATTERNS) redacted = redacted.replace(pattern, "[redacted]");
  for (const pattern of INLINE_PATCH_PATTERNS) redacted = redacted.replace(pattern, "[redacted]");
  redacted = redacted
    .split(/\r?\n/)
    .map((line) => (PATCH_LINE_PATTERN.test(line) ? "[redacted]" : line))
    .join("\n");
  return redacted;
}
