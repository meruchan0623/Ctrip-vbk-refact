import type { UiPeripheralWrite } from './client.ts';

export interface UiRecommendProduct {
  readonly id: string;
  readonly name: string;
  readonly image_url: string;
  readonly departure_city: string;
  readonly destination_city: string;
  readonly detail_url: string;
  readonly price_text: string;
  readonly sendable: boolean;
  readonly unavailable_reason?: string;
}
export interface UiRecommendProducts {
  readonly kind: 'ready' | 'forbidden';
  readonly items: readonly UiRecommendProduct[];
  readonly page_index: number;
  readonly has_more: boolean;
  readonly total: number | null;
  readonly selection_token: string;
  readonly expires_at_ms: number;
  readonly reason?: string;
}
export interface UiRecommendCities { readonly items: readonly { readonly id: number; readonly name: string }[] }
export interface UiRecommendSend extends UiPeripheralWrite { readonly local_id?: string; readonly message_id?: string }
