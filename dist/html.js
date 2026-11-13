// Markup helpers: interpolated values are escaped unless they come from safe`` or raw().
const ENTITIES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
export const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ENTITIES[c]);
class SafeHTML {
  constructor(value) {
    this.value = value;
  }
  toString() {
    return this.value;
  }
}
// Only for markup built by trusted helpers in this project, never for user or remote text.
export const raw = (markup) => new SafeHTML(String(markup ?? ''));
const part = (value) =>
  value == null || value === false
    ? ''
    : value instanceof SafeHTML
      ? value.value
      : Array.isArray(value)
        ? value.map(part).join('')
        : esc(value);
export function safe(strings, ...values) {
  let markup = strings[0];
  values.forEach((value, index) => {
    markup += part(value) + strings[index + 1];
  });
  return new SafeHTML(markup);
}
// Inline icon from the SVG sprite in index.html.
export const icon = (name, className = 'icon') =>
  safe`<svg class="${className}" aria-hidden="true" focusable="false"><use href="#i-${name}"></use></svg>`;
