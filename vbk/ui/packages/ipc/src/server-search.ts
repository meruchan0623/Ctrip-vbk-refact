import type { UiMessage } from './client.ts';

export type ServerSearchType = 0 | 1 | 2 | 3 | 4;
export type ServerSearchGroup = 'customer' | 'content' | 'order' | 'date';
export interface UiServerSearchQuery {
  readonly query_id: string;
  readonly search_type: ServerSearchType;
  readonly search_value?: string;
  readonly page_no: number;
  readonly start_ms?: number;
  readonly end_ms?: number;
}
export interface UiServerSearchHit {
  readonly selection_token: string;
  readonly gid: string;
  readonly title: string;
  readonly preview: string;
  readonly message_id: string | null;
  readonly time_ms: number;
}
export interface UiServerSearchPage {
  readonly query_id: string;
  readonly search_type: ServerSearchType;
  readonly page_no: number;
  readonly page_count: number;
  readonly has_more: boolean;
  readonly groups: Readonly<Record<ServerSearchGroup, readonly UiServerSearchHit[]>>;
}
export interface UiSearchHistoryRequest {
  readonly selection_token: string;
  readonly direction: 'prev' | 'next';
  readonly cursor_ms?: number;
}
export interface UiSearchHistoryPage {
  readonly selection_token: string;
  readonly direction: 'prev' | 'next';
  readonly items: readonly UiMessage[];
  readonly cursor_ms: number | null;
  readonly has_more: boolean;
  readonly anchor_message_id: string | null;
}
