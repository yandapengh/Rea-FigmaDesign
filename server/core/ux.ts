/// <reference lib="es2022" />
/** UX spatial features (stage 7, promoted from the lab). */
import { Graph } from './graph';

export const UX_FEATURES = [
  'areaTop', 'areaMid', 'areaBottom', 'textTop', 'textBottom', 'whitespace',
  'listRun', 'gridCols', 'instanceArea', 'mediaArea', 'textDensity',
  'navBar', 'ctaBottom', 'cardCenter', 'scrimOverlay',
];

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** 15 plain-language spatial features for a screen root. */
export function uxFeatures(g: Graph, id: string): number[] {
  const n = g.nodes.get(id)!;
  const sx = n.bbox_x ?? 0, sy = n.bbox_y ?? 0, sw = n.bbox_w ?? 390, sh = n.bbox_h ?? 844;
  const screenArea = sw * sh;
  const kids = g.children.get(id) ?? [];
  const zoneArea = [0, 0, 0];
  const zoneText = [0, 0];
  let childArea = 0, mediaArea = 0, instArea = 0;
  const hashes: string[] = [];
  for (const kid of kids) {
    const k = g.nodes.get(kid)!;
    const w = k.bbox_w ?? 0, h = k.bbox_h ?? 0;
    const area = w * h;
    if (area > 0) {
      childArea += area;
      const cy = (k.bbox_y ?? sy) - sy + h / 2;
      const z = cy < sh * 0.25 ? 0 : cy < sh * 0.75 ? 1 : 2;
      zoneArea[z] += area;
      if (k.type === 'TEXT') { if (z === 0) zoneText[0] += 1; if (z === 2) zoneText[1] += 1; }
      if (k.type === 'INSTANCE') instArea += area;
      if (k.type === 'RECTANGLE' || k.type === 'VECTOR') mediaArea += area;
    }
    hashes.push(g.hash.get(kid) ?? '');
  }
  const sub = g.subtree(id);
  let textsAll = 0;
  for (const sid of sub) if (g.nodes.get(sid)?.type === 'TEXT') textsAll += 1;
  const whitespace = 1 - clamp(childArea / screenArea, 0, 1);
  let curRun = 1;
  let maxRun = 1;
  for (let i = 1; i < hashes.length; i += 1) {
    if (hashes[i] && hashes[i] === hashes[i - 1]) {
      curRun += 1;
      if (curRun > maxRun) maxRun = curRun;
    } else {
      curRun = 1;
    }
  }
  const listRun = kids.length > 0 ? Math.max(0, maxRun - 1) / kids.length : 0;
  const xb = new Map<number, number>();
  for (const kid of kids) { const k = g.nodes.get(kid)!; const px = Math.round((k.bbox_x ?? sx) / 24); xb.set(px, (xb.get(px) ?? 0) + 1); }
  const gridCols = kids.length > 0 ? Math.max(...xb.values()) / kids.length : 0;
  const nav = kids.some((kid) => { const k = g.nodes.get(kid)!; const ry = (k.bbox_y ?? sy) - sy; return ry < 70 && (k.bbox_w ?? 0) > sw * 0.85 && (k.bbox_h ?? 0) >= 40 && (k.bbox_h ?? 0) <= 120; }) ? 1 : 0;
  const cta = kids.some((kid) => { const k = g.nodes.get(kid)!; const ry = (k.bbox_y ?? sy) - sy; const w = k.bbox_w ?? 0; const h = k.bbox_h ?? 0; return ry > sh * 0.72 && w > sw * 0.5 && w < sw * 0.95 && h >= 40 && h <= 90; }) ? 1 : 0;
  const card = kids.some((kid) => { const k = g.nodes.get(kid)!; const x = (k.bbox_x ?? sx) - sx; const y = (k.bbox_y ?? sy) - sy; const w = k.bbox_w ?? 0; const h = k.bbox_h ?? 0; return w > sw * 0.7 && w < sw * 0.96 && h > sh * 0.25 && h < sh * 0.85 && x > sw * 0.02 && x + w < sw * 0.98 && y > sh * 0.05; }) ? 1 : 0;
  const full = kids.some((kid) => { const k = g.nodes.get(kid)!; return (k.bbox_w ?? 0) >= sw * 0.98 && (k.bbox_h ?? 0) >= sh * 0.98; });
  const scrim = full && kids.length > 1 ? 1 : 0;
  return [
    zoneArea[0] / screenArea, zoneArea[1] / screenArea, zoneArea[2] / screenArea,
    textsAll > 0 ? zoneText[0] / textsAll : 0, textsAll > 0 ? zoneText[1] / textsAll : 0,
    whitespace, listRun, gridCols,
    instArea / screenArea, mediaArea / screenArea,
    sub.length > 0 ? textsAll / sub.length : 0,
    nav, cta, card, scrim,
  ];
}
