import { pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core'
export const healthEvents = pgTable('health_events', { id: serial('id').primaryKey(), message: text('message').notNull(), createdAt: timestamp('created_at').defaultNow().notNull() })
