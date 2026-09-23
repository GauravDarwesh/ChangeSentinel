# Regulatory Monitoring Crawler POC

Real regulator: European Banking Authority
Seed: https://www.eba.europa.eu/

Flow:
EBA -> Stealth Crawler -> URL manifest -> NEW/CHANGED/REMOVED -> OpenRouter free AI

This is a test POC, not a production compliance system.

Required GitHub Actions secret:
OPENROUTER_API_KEY

The initial workflow is intentionally capped at 50 discovered URLs.
