# Data Model

## Table Purpose

For each PostgreSQL table, state the business entity, ownership boundary, retention policy, expected row volume, and why a relational table is appropriate.

## Fields and Types

List every field with PostgreSQL type, nullability, default, validation rule, example value, and whether it is sensitive or personally identifiable data.

## Keys and Constraints

Define primary keys, foreign keys, unique constraints, check constraints, generated values, and the behavior when a referenced record is deleted.

## Indexes

For each index, record its columns and order, query it supports, selectivity expectation, and the write or storage cost it introduces.

## Relationships

Describe one-to-one, one-to-many, and many-to-many relationships, cardinality, ownership, and how the API exposes each relationship.

## Lifecycle

Document creation, state transitions, updates, soft deletion or archival, retention, and the audit history required for the entity.

## Sensitive Data

Identify secrets and personal data, encryption or hashing requirements, access roles, masking rules, export/deletion obligations, and logging restrictions.

## Migration Notes

Describe the ordered migration, backfill strategy, lock and downtime risk, rollback or forward-fix plan, and how the migration is tested against production-like data.
