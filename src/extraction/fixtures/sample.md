---
title: Gateway Operations
owner: Payments Team
draft: false
---
# Gateway Guide

Welcome to the **gateway** documentation.

## Retry Policy

- Retry transient failures.
- Do not retry declined cards.

> Preserve the original request identifier.

| Status | Action |
| --- | --- |
| 503 | Retry |

```ts
const retryable = status === 503;
```
