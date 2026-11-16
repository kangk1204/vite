import type { DeliveryInspection } from '../../src/types';

export function renderDeliveryPresentation(
  envelope: DeliveryInspection | undefined,
  options?: {
    condition?: 'full' | 'basic';
    links?: Array<{ label: string; href?: string; source?: { table: string; row: number } }>;
  },
): string;
