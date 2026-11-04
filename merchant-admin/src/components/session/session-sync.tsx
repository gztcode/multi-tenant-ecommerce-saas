'use client';

import { createSessionSyncComponent } from '@ecom/frontend-shared/session-sync-component';
import { createSessionSync } from '@/lib/session-sync';

export const SessionSync = createSessionSyncComponent(createSessionSync);
