import { Chess } from 'chess.js';
import { START_FEN } from '../state.js';
import { createNode } from './tree.js';

const HASH_PREFIX = '#a=';

function toBase64Url(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(b64) {
  const padded = b64.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

function serializeChildren(children) {
  return children.map((ch) => {
    const entry = [ch.uci];
    const sub = ch.children.length ? serializeChildren(ch.children) : [];
    const hasNags = ch.nags && ch.nags.length > 0;
    const hasComment = Boolean(ch.comment);
    if (sub.length || hasComment || hasNags) entry.push(sub);
    if (hasComment || hasNags) entry.push(ch.comment || '');
    if (hasNags) entry.push(ch.nags);
    return entry;
  });
}

function findPathToNode(root, target) {
  if (!root || !target || root === target) return [];
  const path = [];
  let cur = target;
  while (cur && cur.parent) {
    const idx = cur.parent.children.indexOf(cur);
    if (idx < 0) return [];
    path.push(idx);
    cur = cur.parent;
  }
  return cur === root ? path.reverse() : [];
}

/**
 * Encode an analysis tab's full variation tree, comments, NAGs, current node
 * pointer, and board orientation into a compact URL hash payload (`#a=...`).
 */
export function encodeShareHash(tab, { flipped = false } = {}) {
  if (!tab?.root) return '';
  const rootFen = tab.root.fen && tab.root.fen !== START_FEN ? tab.root.fen : null;
  const tree = serializeChildren(tab.root.children);
  const path = findPathToNode(tab.root, tab.current);
  const title = tab.title && !/^Analysis \d+$/.test(tab.title) ? tab.title : null;

  const payload = [rootFen, tree, path, flipped ? 1 : 0];
  if (title) payload.push(title);

  return HASH_PREFIX + toBase64Url(JSON.stringify(payload));
}

function rebuildSubtree(parentNode, serializedChildren) {
  if (!Array.isArray(serializedChildren)) return;
  for (const item of serializedChildren) {
    if (!Array.isArray(item) || typeof item[0] !== 'string' || item[0].length < 4) continue;
    const uci = item[0];
    const subChildren = Array.isArray(item[1]) ? item[1] : [];
    const comment = typeof item[2] === 'string' ? item[2] : '';
    const nags = Array.isArray(item[3]) ? item[3].filter((x) => typeof x === 'string') : [];

    let chess;
    try {
      chess = new Chess(parentNode.fen);
    } catch (_) {
      continue;
    }
    let m;
    try {
      m = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || undefined });
    } catch (_) {
      continue;
    }
    if (!m) continue;

    const moveNum = parseInt(parentNode.fen.split(' ')[5] || '1', 10) || 1;
    const node = createNode({
      parent: parentNode,
      san: m.san,
      uci: m.from + m.to + (m.promotion || ''),
      from: m.from,
      to: m.to,
      promotion: m.promotion || '',
      fen: chess.fen(),
      color: m.color,
      moveNum,
      comment,
      nags,
    });
    parentNode.children.push(node);
    rebuildSubtree(node, subChildren);
  }
}

/**
 * Decode a `#a=...` URL hash into `{ root, current, flipped, title }`, or
 * return `null` if the hash is absent or malformed.
 */
export function decodeShareHash(hash) {
  if (!hash || typeof hash !== 'string' || !hash.startsWith(HASH_PREFIX)) return null;
  const encoded = hash.slice(HASH_PREFIX.length).trim();
  if (!encoded) return null;

  let payload;
  try {
    payload = JSON.parse(fromBase64Url(encoded));
  } catch (_) {
    return null;
  }

  if (!Array.isArray(payload) || payload.length < 3) return null;

  const startFen = typeof payload[0] === 'string' && payload[0] ? payload[0] : START_FEN;
  let validator;
  try {
    validator = new Chess(startFen);
  } catch (_) {
    return null;
  }

  const root = createNode({ fen: validator.fen() });
  rebuildSubtree(root, payload[1]);

  let current = root;
  const path = Array.isArray(payload[2]) ? payload[2] : [];
  for (const idx of path) {
    if (typeof idx === 'number' && current.children[idx]) {
      current = current.children[idx];
    } else {
      break;
    }
  }

  const flipped = Boolean(payload[3]);
  const title = typeof payload[4] === 'string' && payload[4].trim() ? payload[4].trim() : 'Shared Analysis';
  return { root, current, flipped, title };
}
