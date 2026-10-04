# Authorized internal tenant and cheaper model preflight

Clerk organization and authenticated API identity independently resolve capiro-internal to tenant `17b63099-bc0f-4ac5-b596-496161e9481e`. The native credential owner resolves its existing active OpenAI key, with Astra and no model override. The same key can read GPT-6.1 Sol model metadata. This verifies metadata access only; inference and answer-quality validation have not run. No credentials were rotated or changed, and ephemeral login was revoked.

The model change remains pending request normalization, pricing, a native model-only configuration update, and a representative quality sample. Customer defaults remain unchanged. Admin identity/configuration reads do not establish ordinary-user benchmark acceptance. Official model reference: https://developers.openai.com/api/docs/models/gpt-6.1-sol.
