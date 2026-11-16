/**
 * Figma AST dehydration.
 *
 * HARD RULES:
 *  - Never touch vectorPaths / vectorNetwork.
 *  - Never use figma.mixed without guarding it (it is a Symbol, not a number).
 *  - Never call synchronous .mainComponent / .getLocalVariables(); the manifest
 *    uses documentAccess: "dynamic-page".
 */

import type { ComponentRow, NodeRow } from '../../shared/protocol';

const ICON_MAX_SIZE = 64;
const VECTOR_LEAF_TYPES = [
  'VECTOR',
  'BOOLEAN_OPERATION',
  'STAR',
  'LINE',
  'ELLIPSE',
  'POLYGON',
];

interface RgbLike {
  r: number;
  g: number;
  b: number;
  a?: number;
}

interface PaintLike {
  type?: unknown;
  visible?: unknown;
  opacity?: unknown;
  color?: RgbLike;
  imageHash?: unknown;
  scaleMode?: unknown;
  gradientStops?: ReadonlyArray<{ position: number; color: RgbLike }>;
}

interface EffectLike {
  type?: unknown;
  visible?: unknown;
  radius?: unknown;
  spread?: unknown;
  color?: RgbLike;
  offset?: { x: number; y: number };
}

interface FontNameLike {
  family?: unknown;
  style?: unknown;
}

/** True for the figma.mixed Symbol. Never call array methods before this check. */
export function isMixed(value: unknown): boolean {
  return value === figma.mixed;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function hexByte(value: number): string {
  return Math.round(clamp01(value) * 255)
    .toString(16)
    .padStart(2, '0')
    .toUpperCase();
}

/** Converts 0..1 Figma floats into #RRGGBB (or #RRGGBBAA when alpha < 1). */
export function rgbToHex(r: number, g: number, b: number, a?: number): string {
  const base = `#${hexByte(r)}${hexByte(g)}${hexByte(b)}`;
  if (typeof a !== 'number') return base;
  const alpha = Math.round(clamp01(a) * 255);
  if (alpha >= 255) return base;
  return `${base}${alpha.toString(16).padStart(2, '0').toUpperCase()}`;
}

function round(value: number, precision = 3): number {
  const factor = Math.pow(10, precision);
  return Math.round(value * factor) / factor;
}

function isRgbLike(value: unknown): value is RgbLike {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.r === 'number' &&
    typeof candidate.g === 'number' &&
    typeof candidate.b === 'number'
  );
}

/**
 * Reads a Figma node field defensively. Some properties throw on node types
 * that do not implement the mixin; dehydration must never abort a whole file
 * because one exotic node lacks a layout field.
 */
function readField<T>(node: object, field: string): T | undefined {
  try {
    if (!(field in node)) return undefined;
    return ((node as unknown) as Record<string, unknown>)[field] as T;
  } catch {
    return undefined;
  }
}

function jsonScalarOrNull(value: unknown): unknown {
  if (value === undefined) return null;
  if (isMixed(value)) return 'MIXED';
  if (typeof value === 'number') return Number.isFinite(value) ? round(value) : null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (value === null) return null;
  return value;
}

function opacityOf(paint: PaintLike): number {
  const raw = typeof paint.opacity === 'number' ? paint.opacity : 1;
  const colorAlpha = paint.color && typeof paint.color.a === 'number' ? paint.color.a : 1;
  return round(clamp01(raw) * clamp01(colorAlpha), 3);
}

function dehydratePaints(value: unknown): unknown {
  if (isMixed(value)) return 'MIXED';
  if (!Array.isArray(value)) return [];
  const paints: unknown[] = [];

  for (let index = 0; index < value.length; index += 1) {
    const paint = value[index] as PaintLike | null;
    if (!paint || typeof paint !== 'object') continue;
    if (paint.visible === false) continue;

    const type = typeof paint.type === 'string' ? paint.type : 'UNKNOWN';

    if (type === 'SOLID' && isRgbLike(paint.color)) {
      paints.push({
        type: 'SOLID',
        hex: rgbToHex(paint.color.r, paint.color.g, paint.color.b),
        opacity: opacityOf(paint),
      });
    } else if (type === 'IMAGE') {
      paints.push({
        type: 'IMAGE',
        imageHash: typeof paint.imageHash === 'string' ? paint.imageHash : null,
        scaleMode: typeof paint.scaleMode === 'string' ? paint.scaleMode : null,
        opacity: opacityOf(paint),
      });
    } else if (type.indexOf('GRADIENT') === 0 && Array.isArray(paint.gradientStops)) {
      const stops: unknown[] = [];
      for (let stopIndex = 0; stopIndex < paint.gradientStops.length; stopIndex += 1) {
        const stop = paint.gradientStops[stopIndex];
        if (!stop || !isRgbLike(stop.color)) continue;
        stops.push({
          hex: rgbToHex(stop.color.r, stop.color.g, stop.color.b, stop.color.a),
          pos: round(stop.position, 4),
        });
      }
      paints.push({ type, opacity: opacityOf(paint), stops });
    } else {
      paints.push({ type, opacity: opacityOf(paint) });
    }
  }

  return paints;
}

function dehydrateEffects(value: unknown): unknown {
  if (isMixed(value)) return 'MIXED';
  if (!Array.isArray(value)) return [];
  const effects: unknown[] = [];

  for (let index = 0; index < value.length; index += 1) {
    const effect = value[index] as EffectLike | null;
    if (!effect || typeof effect !== 'object') continue;
    if (effect.visible === false) continue;

    const entry: Record<string, unknown> = {
      type: typeof effect.type === 'string' ? effect.type : 'UNKNOWN',
    };
    if (typeof effect.radius === 'number') entry.radius = round(effect.radius);
    if (typeof effect.spread === 'number') entry.spread = round(effect.spread);
    if (isRgbLike(effect.color)) {
      entry.hex = rgbToHex(effect.color.r, effect.color.g, effect.color.b);
    }
    if (effect.offset && typeof effect.offset.x === 'number' && typeof effect.offset.y === 'number') {
      entry.offset = [round(effect.offset.x), round(effect.offset.y)];
    }
    effects.push(entry);
  }

  return effects;
}

function dehydrateStyle(node: SceneNode): string {
  const style = {
    fills: dehydratePaints(readField<unknown>(node, 'fills')),
    strokes: dehydratePaints(readField<unknown>(node, 'strokes')),
    strokeWeight: jsonScalarOrNull(readField<unknown>(node, 'strokeWeight')),
    strokeAlign: jsonScalarOrNull(readField<unknown>(node, 'strokeAlign')),
    cornerRadius: jsonScalarOrNull(readField<unknown>(node, 'cornerRadius')),
    effects: dehydrateEffects(readField<unknown>(node, 'effects')),
  };
  return JSON.stringify(style);
}

function extractLayout(node: SceneNode): { mode: string; json: string } {
  const rawMode = readField<unknown>(node, 'layoutMode');
  const mode = typeof rawMode === 'string' ? rawMode : 'NONE';
  const props = {
    primaryAlign: jsonScalarOrNull(readField<unknown>(node, 'primaryAxisAlignItems')),
    counterAlign: jsonScalarOrNull(readField<unknown>(node, 'counterAxisAlignItems')),
    sizingH: jsonScalarOrNull(readField<unknown>(node, 'layoutSizingHorizontal')),
    sizingV: jsonScalarOrNull(readField<unknown>(node, 'layoutSizingVertical')),
    padding: [
      jsonScalarOrNull(readField<unknown>(node, 'paddingTop')),
      jsonScalarOrNull(readField<unknown>(node, 'paddingRight')),
      jsonScalarOrNull(readField<unknown>(node, 'paddingBottom')),
      jsonScalarOrNull(readField<unknown>(node, 'paddingLeft')),
    ],
    itemSpacing: jsonScalarOrNull(readField<unknown>(node, 'itemSpacing')),
    counterAxisSpacing: jsonScalarOrNull(readField<unknown>(node, 'counterAxisSpacing')),
    layoutWrap: jsonScalarOrNull(readField<unknown>(node, 'layoutWrap')),
  };
  return { mode, json: JSON.stringify(props) };
}

function extractTextStyle(node: SceneNode): string {
  const fontName = readField<unknown>(node, 'fontName');
  let fontFamily: unknown = null;
  let fontStyle: unknown = null;

  if (isMixed(fontName)) {
    fontFamily = 'MIXED';
    fontStyle = 'MIXED';
  } else if (typeof fontName === 'object' && fontName !== null) {
    const font = fontName as FontNameLike;
    fontFamily = typeof font.family === 'string' ? font.family : null;
    fontStyle = typeof font.style === 'string' ? font.style : null;
  }

  return JSON.stringify({
    fontFamily,
    fontStyle,
    fontSize: jsonScalarOrNull(readField<unknown>(node, 'fontSize')),
    fontWeight: jsonScalarOrNull(readField<unknown>(node, 'fontWeight')),
    lineHeight: jsonScalarOrNull(readField<unknown>(node, 'lineHeight')),
    textAlignHorizontal: jsonScalarOrNull(readField<unknown>(node, 'textAlignHorizontal')),
  });
}

function dehydrateAction(value: unknown): Record<string, unknown> {
  const action = (value ?? {}) as Record<string, unknown>;
  const result: Record<string, unknown> = {
    type: typeof action.type === 'string' ? action.type : 'UNKNOWN',
  };
  if (typeof action.destinationId === 'string') result.destinationId = action.destinationId;
  if (typeof action.navigation === 'string') result.navigation = action.navigation;
  if (typeof action.url === 'string') result.url = action.url;
  if (typeof action.variableId === 'string') result.variableId = action.variableId;
  return result;
}

function dehydrateReactions(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const reactions: unknown[] = [];

  for (let index = 0; index < value.length; index += 1) {
    const reaction = value[index] as Record<string, unknown> | null;
    if (!reaction || typeof reaction !== 'object') continue;

    const trigger = reaction.trigger as Record<string, unknown> | null | undefined;
    const actionsValue = reaction.actions;
    const actions: unknown[] = Array.isArray(actionsValue)
      ? actionsValue.map(dehydrateAction)
      : reaction.action
        ? [dehydrateAction(reaction.action)]
        : [];

    reactions.push({
      trigger: trigger && typeof trigger.type === 'string' ? trigger.type : null,
      actions,
    });
  }

  if (reactions.length === 0) return null;
  try {
    return JSON.stringify(reactions);
  } catch {
    return null;
  }
}

export function getNodeChildren(node: SceneNode): readonly SceneNode[] | null {
  const children = readField<readonly SceneNode[]>(node, 'children');
  return Array.isArray(children) ? children : null;
}

/**
 * An icon container is a small (<= 64x64) node whose entire subtree is pure
 * vector geometry. Its children carry thousands of path points, so we record
 * the container as is_icon_container = 1 and prune the subtree.
 */
export function isIconContainer(node: SceneNode): boolean {
  const children = getNodeChildren(node);
  if (children === null) return false;
  return isIconContainerWithBox(node, children, readField<Rect | null>(node, 'absoluteBoundingBox'));
}

function isIconContainerWithBox(
  node: SceneNode,
  children: readonly SceneNode[],
  box: Rect | null | undefined,
): boolean {
  if (children.length === 0) return false;
  if (!box || box.width > ICON_MAX_SIZE || box.height > ICON_MAX_SIZE) return false;

  const stack: SceneNode[] = [];
  for (let index = 0; index < children.length; index += 1) stack.push(children[index]);

  let visited = 0;
  while (stack.length > 0) {
    const current = stack.pop() as SceneNode;
    if (VECTOR_LEAF_TYPES.indexOf(current.type) === -1) return false;
    visited += 1;

    const nested = getNodeChildren(current);
    if (nested !== null) {
      for (let index = 0; index < nested.length; index += 1) stack.push(nested[index]);
    }
  }

  return visited > 0;
}

export interface DehydratedNode {
  row: NodeRow;
  shouldSkipChildren: boolean;
}

export async function dehydrateNode(
  node: SceneNode,
  parentId: string | null,
  pageId: string,
  pageName: string,
  childIndex: number,
  depth: number,
): Promise<DehydratedNode> {
  const box = readField<Rect | null>(node, 'absoluteBoundingBox');
  const children = getNodeChildren(node);
  const iconContainer =
    children !== null && isIconContainerWithBox(node, children, box);
  const layout = extractLayout(node);

  let mainComponentId: string | null = null;
  if (node.type === 'INSTANCE') {
    try {
      const main = await node.getMainComponentAsync();
      mainComponentId = main ? main.id : null;
    } catch {
      mainComponentId = null;
    }
  }

  const isText = node.type === 'TEXT';
  const textContent = isText ? readField<string>(node, 'characters') ?? '' : null;
  const textStyle = isText ? extractTextStyle(node) : null;

  const boundVariables = readField<unknown>(node, 'boundVariables');
  let boundVariablesJson = '{}';
  if (boundVariables !== undefined) {
    try {
      boundVariablesJson = JSON.stringify(boundVariables);
    } catch {
      boundVariablesJson = '{}';
    }
  }

  const row: NodeRow = {
    id: node.id,
    parent_id: parentId,
    page_id: pageId,
    page_name: pageName,
    child_index: childIndex,
    depth,
    type: node.type,
    name: node.name,
    visible: node.visible ? 1 : 0,
    main_component_id: mainComponentId,
    is_icon_container: iconContainer ? 1 : 0,
    layout_mode: layout.mode,
    layout_props_json: layout.json,
    bbox_x: box ? round(box.x) : null,
    bbox_y: box ? round(box.y) : null,
    bbox_w: box ? round(box.width) : null,
    bbox_h: box ? round(box.height) : null,
    style_json: dehydrateStyle(node),
    bound_variables_json: boundVariablesJson,
    text_content: textContent,
    text_style_json: textStyle,
    reactions_json: dehydrateReactions(readField<unknown>(node, 'reactions')),
  };

  const shouldSkipChildren =
    iconContainer || node.type === 'VECTOR' || node.type === 'BOOLEAN_OPERATION';

  return { row, shouldSkipChildren };
}

/** Converts one Figma variable value into a compact JSON-safe form. */
export function dehydrateVariableValue(value: unknown): unknown {
  if (isMixed(value)) return 'MIXED';
  if (value === null || value === undefined) return null;

  if (typeof value === 'object') {
    const candidate = value as Record<string, unknown>;
    if (candidate.type === 'VARIABLE_ALIAS' && typeof candidate.id === 'string') {
      return { type: 'VARIABLE_ALIAS', id: candidate.id };
    }
    if (isRgbLike(candidate)) {
      return rgbToHex(
        candidate.r,
        candidate.g,
        candidate.b,
        typeof candidate.a === 'number' ? candidate.a : undefined,
      );
    }
  }

  return value;
}

/** Records COMPONENT / COMPONENT_SET metadata and its parent set linkage. */
export function dehydrateComponent(
  node: ComponentNode | ComponentSetNode,
  pageId: string,
  pageName: string,
): ComponentRow {
  const isSet = node.type === 'COMPONENT_SET';
  const parent = node.parent;
  const parentSet = !isSet && parent !== null && parent.type === 'COMPONENT_SET' ? parent : null;

  let variantPropertiesJson: string | null = null;
  try {
    if (isSet) {
      variantPropertiesJson = JSON.stringify(node.variantGroupProperties);
    } else {
      const variantProperties = readField<unknown>(node, 'variantProperties');
      if (variantProperties !== undefined && variantProperties !== null) {
        variantPropertiesJson = JSON.stringify(variantProperties);
      }
    }
  } catch {
    variantPropertiesJson = null;
  }

  return {
    id: node.id,
    key: readField<string>(node, 'key') ?? '',
    name: node.name,
    component_set_id: parentSet ? parentSet.id : null,
    component_set_name: parentSet ? parentSet.name : null,
    variant_properties_json: variantPropertiesJson,
    description: readField<string>(node, 'description') ?? '',
    page_id: pageId,
    page_name: pageName,
  };
}
