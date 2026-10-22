/**
 * 轻量 XML 解析/序列化。EPUB 的 container.xml、OPF、NCX、XHTML 都是格式良好的 XML，
 * 因此不引入 DOM：浏览器与 Node 单元测试共用同一套解析结果。
 */

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

export function decodeEntities(text) {
  return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

export function escapeText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function escapeAttribute(value) {
  return escapeText(value).replace(/"/g, '&quot;');
}

function findTagEnd(text, from) {
  let quote = '';
  for (let i = from + 1; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '>') return i;
  }
  return -1;
}

function parseAttributes(source) {
  const attrs = {};
  const re = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')|([\w:.-]+)/g;
  let match;
  while ((match = re.exec(source))) {
    if (match[1] !== undefined) {
      attrs[match[1]] = decodeEntities(match[2] ?? match[3] ?? '');
    } else if (match[4] !== undefined) {
      attrs[match[4]] = '';
    }
  }
  return attrs;
}

/**
 * 解析 XML 文本，返回 `{ name: '#document', attrs: {}, children: [] }` 树。
 * 文本节点形如 `{ name: '#text', value: '...' }`。
 */
export function parseXml(source) {
  const text = String(source ?? '');
  const root = { name: '#document', attrs: {}, children: [] };
  const stack = [root];
  let position = 0;

  const addText = (value) => {
    if (!value) return;
    stack[stack.length - 1].children.push({ name: '#text', value: decodeEntities(value) });
  };

  while (position < text.length) {
    const lt = text.indexOf('<', position);
    if (lt === -1) {
      addText(text.slice(position));
      break;
    }
    if (lt > position) addText(text.slice(position, lt));

    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      position = end === -1 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      addText(text.slice(lt + 9, end === -1 ? text.length : end));
      position = end === -1 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2);
      position = end === -1 ? text.length : end + 2;
      continue;
    }
    if (text.startsWith('<!', lt)) {
      // DOCTYPE 等声明：跳过（内部子集用 [] 包裹，直接找下一个 > 可能过早，简单处理即可）
      let end = text.indexOf('>', lt);
      const bracket = text.indexOf('[', lt);
      if (bracket !== -1 && end !== -1 && bracket < end) {
        const close = text.indexOf(']', bracket);
        end = close === -1 ? end : text.indexOf('>', close);
      }
      position = end === -1 ? text.length : end + 1;
      continue;
    }

    const gt = findTagEnd(text, lt);
    if (gt === -1) {
      addText(text.slice(lt));
      break;
    }

    const raw = text.slice(lt + 1, gt).trim();
    if (raw.startsWith('/')) {
      if (stack.length > 1) stack.pop();
      position = gt + 1;
      continue;
    }

    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1).trim() : raw;
    const nameEnd = body.search(/[\s/]/);
    const name = nameEnd === -1 ? body : body.slice(0, nameEnd);
    const attrs = parseAttributes(nameEnd === -1 ? '' : body.slice(nameEnd));

    const node = { name, attrs, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);

    position = gt + 1;
  }

  return root;
}

export function localName(name) {
  const index = String(name).indexOf(':');
  return index === -1 ? String(name) : String(name).slice(index + 1);
}

export function getAttribute(node, name) {
  if (!node?.attrs) return undefined;
  if (Object.prototype.hasOwnProperty.call(node.attrs, name)) return node.attrs[name];
  for (const [key, value] of Object.entries(node.attrs)) {
    if (localName(key) === name) return value;
  }
  return undefined;
}

export function findAll(node, predicate, out = []) {
  if (!node || !node.children) return out;
  for (const child of node.children) {
    if (child.name === '#text') continue;
    if (predicate(child)) out.push(child);
    findAll(child, predicate, out);
  }
  return out;
}

export function findFirst(node, predicate) {
  return findAll(node, predicate, [])[0] ?? null;
}

export function textOf(node) {
  if (!node) return '';
  if (node.name === '#text') return node.value;
  let out = '';
  for (const child of node.children ?? []) out += textOf(child);
  return out;
}

export function serialize(node) {
  if (!node) return '';
  if (node.name === '#text') return escapeText(node.value);
  if (node.name === '#document') return (node.children ?? []).map(serialize).join('');

  const attrs = Object.entries(node.attrs ?? {})
    .map(([key, value]) => (value === '' ? ` ${key}` : ` ${key}="${escapeAttribute(value)}"`))
    .join('');
  const children = (node.children ?? []).map(serialize).join('');
  if (!children && VOID_ELEMENTS.has(localName(node.name).toLowerCase())) {
    return `<${node.name}${attrs}/>`;
  }
  return `<${node.name}${attrs}>${children}</${node.name}>`;
}

export function textNode(value) {
  return { name: '#text', value: String(value) };
}
