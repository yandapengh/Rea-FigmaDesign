/**
 * Rea-FigmaDesign Phase 1 — shared wire + storage contracts.
 *
 * This file is imported by BOTH the local Node server (tsx) and the Figma
 * plugin bundle (esbuild). Keep it free of runtime imports so it stays
 * platform-neutral.
 */

export interface FileMetaPayload {
  file_key: string;
  file_name: string;
  extracted_at: string;
  page_count: number;
  pages?: Array<{ page_id: string; page_name: string; page_index: number }>;
}

export interface VariableRow {
  id: string;
  name: string;
  collection_id: string;
  collection_name: string;
  resolved_type: string; // 'COLOR' | 'FLOAT' | 'STRING' | 'BOOLEAN'
  values_by_mode_json: string; // JSON string of modeId -> resolved hex/value or alias { type: 'VARIABLE_ALIAS', id: string }
  scopes_json: string; // JSON array of scopes
}

export interface ComponentRow {
  id: string;
  key: string;
  name: string;
  component_set_id: string | null;
  component_set_name: string | null;
  variant_properties_json: string | null;
  description: string;
  page_id: string;
  page_name: string;
}

export interface NodeRow {
  id: string;
  parent_id: string | null;
  page_id: string;
  page_name: string;
  child_index: number;
  depth: number;
  type: string;
  name: string;
  visible: number; // 1 or 0
  main_component_id: string | null;
  is_icon_container: number; // 1 or 0
  layout_mode: string; // 'NONE' | 'HORIZONTAL' | 'VERTICAL'
  layout_props_json: string; // JSON: { primaryAlign, counterAlign, sizingH, sizingV, padding: [t,r,b,l], itemSpacing, counterAxisSpacing, layoutWrap }
  bbox_x: number | null;
  bbox_y: number | null;
  bbox_w: number | null;
  bbox_h: number | null;
  style_json: string; // JSON: dehydrated fills (hex/opacity), strokes, cornerRadius, effects
  bound_variables_json: string; // JSON: raw node.boundVariables map
  text_content: string | null;
  text_style_json: string | null; // JSON: { fontFamily, fontStyle, fontSize, fontWeight, lineHeight, textAlignHorizontal }
  reactions_json: string | null; // JSON: prototype navigation links if any
}

export interface PageCensusRow {
  page_id: string;
  page_name: string;
  page_index: number;
  child_count: number;
  is_empty: number; // 1 or 0
}

export interface PageStartPayload {
  file_key: string;
  page_id: string;
  page_name: string;
  page_index: number;
  child_count?: number;
  is_empty?: number;
}

export interface PageSkipPayload {
  file_key?: string;
  page_id: string;
  page_name: string;
  page_index: number;
}

export interface PageCompletePayload {
  file_key: string;
  page_id: string;
  total_nodes?: number;
}

export type PageSyncStatus = 'SYNCING' | 'DONE' | 'INCOMPLETE';

export interface PageStatusRow {
  file_key: string;
  page_id: string;
  page_name: string;
  page_index: number;
  status: PageSyncStatus;
  node_count: number;
  synced_at: string | null;
  child_count: number;
  is_empty: number;
  census_at: string | null;
}

export interface ResetDatabasePayload {
  confirm: true;
}

export type BridgeClientRole = 'figma-plugin' | 'review-ui';

export interface BridgeHelloPayload {
  role: BridgeClientRole;
  file_key?: string;
  file_name?: string;
}

export interface BridgeFocusRequestPayload {
  request_id: string;
  node_ids: string[];
  page_id?: string;
  page_name?: string;
  page_only?: boolean;
}

export interface BridgeFocusResultPayload {
  request_id: string;
  ok: boolean;
  page_id?: string;
  page_name?: string;
  page_only?: boolean;
  selected_count?: number;
  missing_ids?: string[];
  cross_page_pages?: Array<{ page_id: string; page_name: string; count: number }>;
  error?: string;
}

export interface BridgeStatusPayload {
  figma_connected: boolean;
  figma_file_name?: string;
  figma_file_key?: string;
  review_clients: number;
}

export interface BridgeSelectionItem {
  id: string;
  name: string;
  type: string;
  page_id: string;
  page_name: string;
  width?: number;
  height?: number;
  text_preview?: string;
  ancestor_ids?: string[];
}

export interface BridgeLookupRequestPayload {
  request_id: string;
  file_key?: string;
  file_name?: string;
  page_id: string;
  page_name: string;
  items: BridgeSelectionItem[];
}

export interface BridgeLookupResultPayload {
  request_id: string;
  ok: boolean;
  total?: number;
  matched_count?: number;
  unrecorded_count?: number;
  error?: string;
}

export type WsMessage =
  | { type: 'PAGE_CENSUS'; payload: PageCensusRow[] }
  | { type: 'SYNC_START'; payload: FileMetaPayload }
  | { type: 'PAGE_START'; payload: PageStartPayload }
  | { type: 'PAGE_SKIP'; payload: PageSkipPayload }
  | { type: 'PAGE_COMPLETE'; payload: PageCompletePayload }
  | { type: 'PAGE_STATUS'; payload: { file_key?: string } }
  | { type: 'RESET_DATABASE'; payload: ResetDatabasePayload }
  | { type: 'CHUNK_VARIABLES'; payload: VariableRow[] }
  | { type: 'CHUNK_COMPONENTS'; payload: ComponentRow[] }
  | { type: 'CHUNK_NODES'; payload: NodeRow[] }
  | { type: 'SYNC_COMPLETE'; payload: { total_nodes: number; duration_ms: number } }
  | { type: 'BRIDGE_HELLO'; payload: BridgeHelloPayload }
  | { type: 'BRIDGE_FOCUS_NODES'; payload: BridgeFocusRequestPayload }
  | { type: 'BRIDGE_FOCUS_RESULT'; payload: BridgeFocusResultPayload }
  | { type: 'BRIDGE_STATUS'; payload: BridgeStatusPayload }
  | { type: 'BRIDGE_LOOKUP_SELECTION'; payload: BridgeLookupRequestPayload }
  | { type: 'BRIDGE_LOOKUP_RESULT'; payload: BridgeLookupResultPayload };

export type WsEnvelopeMessage = WsMessage & { batch_id?: number };
