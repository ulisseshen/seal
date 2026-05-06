# Curadoria de Modelos para Coding — 15 Abril 2026

> Dados cruzados: [Onyx.app](https://onyx.app/best-llm-for-coding) + preços de API atualizados + lançamentos recentes.

---

## Tabela Completa (ordenada por SWE-bench Verified)

| # | Modelo | SWE-bench | LiveCode | HumanEval | Terminal-Bench | Input/1M | Output/1M | Ctx | Nota |
|---|--------|-----------|----------|-----------|----------------|----------|-----------|-----|------|
| 1 | **Claude Opus 4.6** | **80.8%** | 76.0 | 95.0 | **65.4** | $15.00 | $75.00 | 200K | Referência (caro) |
| 2 | **MiniMax M2.5** | **80.2%** | 65.0 | 89.6 | 42.2 | $0.30 | $1.20 | 205K | Quase Opus por 1/50 do preço |
| 3 | **Claude Sonnet 4.6** | 79.6% | 72.4 | 92.1 | 59.1 | $3.00 | $15.00 | 200K | Melhor "confiável" no preço médio |
| 4 | **🆕 Qwen 3.6 Plus** | **78.8%** | - | ~90 | **61.6** | $0.50 | $3.00 | **1M** | LANÇAMENTO 2 abril! Terminal-Bench #2 |
| 5 | **Gemini 3.1 Pro** | 78.0% | **81.3** | 93.0 | 56.2 | $2.00 | $12.00 | **1M** | Reasoning #1, contexto gigante |
| 6 | **GLM-5** | 77.8% | 52.0 | 90.0 | 56.2 | ~$0.10 | ~$0.40 | 200K | Chatbot Arena #1, LiveCode fraco |
| 7 | **Kimi K2.5** | 76.8% | **85.0** | **99.0** | 50.8 | $0.60 | $2.50 | 262K | HumanEval perfeito, multimodal |
| 8 | **Qwen 3.5 Plus** | 76.4% | **83.6** | - | 52.5 | $0.26 | $1.56 | 262K | 3x mais barato que o 3.6 |
| 9 | **Step-3.5-Flash** | 74.4% | **86.4** | 81.1 | 51.0 | **$0.10** | **$0.30** | 256K | LiveCode #1 absurdo |
| 10 | **MiMo-V2-Flash** | 73.4% | 80.6 | 84.8 | 38.5 | **$0.09** | **$0.29** | 262K | O mais barato de todos |
| 11 | **DeepSeek V3.2** | 67.8% | 74.1 | - | 39.6 | $0.28 | $0.42 | 130K | MIT license, bom pra agente |
| 12 | **GPT-5.4** | - | - | - | **75.1** | $2.50 | $15.00 | 1M | Terminal-Bench #1, poucos benchmarks públicos |
| 13 | **GLM-5.1** | - | - | - | - | $1.40 | $4.40 | 200K | Coding refinado do GLM-5 |
| 14 | **Grok 3** | 49.0% | 79.4 | 94.5 | 52.0 | $3.00 | $15.00 | 131K | Caro pro que entrega |

---

## 🆕 Lançamento: Qwen 3.6 Plus (2 abril 2026)

**Status (15 abril):** ⚠️ Problemas de capacidade — Alibaba tirando do ar temporariamente. Qwen 3.5 Plus também afetado. Equipe trabalhando no fix. ([fonte: @opencode](https://x.com/opencode))

### Por que importa

- **SWE-bench 78.8%** — ultrapassa Gemini 3.1 Pro e GLM-5
- **Terminal-Bench 61.6** — segundo lugar, só perde pro GPT-5.4 (75.1)
- **1M de contexto** por $0.50/$3.00 — Gemini-tier de contexto por 1/4 do preço
- **158 tok/s** — 2x mais rápido que GPT-5.4 (76 tok/s) e Claude Opus (93.5 tok/s)
- **Consistência 10/10** — zero testes flaky (Qwen 3.5 tinha 2)
- Usa 83% reasoning / 17% output (3.5 era 91%/9%) — mais eficiente em tokens
- Suporta imagens nativamente

### Qwen 3.6 Plus vs Qwen 3.5 Plus

| Métrica | 3.5 Plus | 3.6 Plus | Diferença |
|---------|----------|----------|-----------|
| SWE-bench | 76.4% | 78.8% | +2.4pp |
| Terminal-Bench | 52.5 | 61.6 | +9.1pp |
| Consistência | 9.0 (2 flaky) | 10.0 (0 flaky) | Perfeito |
| Velocidade | ~100 tok/s | 158 tok/s | +58% |
| Input/1M | $0.26 | $0.50 | 2x mais caro |
| Output/1M | $1.56 | $3.00 | 2x mais caro |
| Contexto | 262K | 1M | 4x maior |

**Veredicto:** Qwen 3.6 é melhor em tudo, mas custa 2x mais. Qwen 3.5 ainda é excelente se preço importa mais que performance de ponta.

---

## Minha Curadoria: Top 7 por Caso de Uso

### 1. 🏆 Coding Pesado (arquitetura, refactoring, bugs complexos)
**MiniMax M2.5** — $0.30/$1.20
- SWE-bench 80.2% (empate técnico com Opus 80.8%)
- **50x mais barato** que Opus
- Melhor ROI absoluto pra coding sério

### 2. 🆕 Agente de Código + Contexto Longo
**Qwen 3.6 Plus** — $0.50/$3.00
- Terminal-Bench 61.6 (#2 geral), SWE-bench 78.8%
- 1M de contexto, 158 tok/s, consistência perfeita
- Ideal pra agentes que precisam de repo inteiro no contexto
- ⚠️ Instabilidade temporária de capacidade (abril 2026)

### 3. ⚡ LiveCodeBench (coding iterativo, competitivo)
**Step-3.5-Flash** — $0.10/$0.30
- LiveCodeBench **86.4%** (o MAIOR da tabela)
- **150x mais barato** que Opus
- Perfeito pra loops de agente com muitas iterações

### 4. 🔪 Canivete Suíço Barato
**Kimi K2.5** — $0.60/$2.50
- HumanEval **99.0%**, LiveCode **85.0%**
- Multimodal nativo (lê imagens/vídeo)
- Bom em tudo, preço justo

### 5. 🧠 Reasoning + Docs Longos
**Gemini 3.1 Pro** — $2.00/$12.00
- GPQA Diamond **91.9%**, contexto **1M**
- Pra quando precisa analisar repo inteiro ou docs enormes

### 6. 💰 Ultrabarato pra Volume
**MiMo-V2-Flash** (Xiaomi) — $0.09/$0.29
- O mais barato com performance decente (LiveCode 80.6%)
- **166x mais barato** que Opus
- Testes, boilerplate, classificação, CI/CD

### 7. 🤝 Equilíbrio Qualidade/Confiança
**Claude Sonnet 4.6** — $3.00/$15.00
- 98-99% da qualidade do Opus
- Terminal-Bench 59.1 (forte em tasks reais)
- Quando precisa da "confiança Claude" sem pagar Opus

---

## O que NÃO vale a pena pra coding

- **Llama 4 Maverick** — HumanEval 62.0%, LiveCode 43.4%. Decepcionante.
- **GPT-oss 120B** — Terminal-Bench 18.7%. Open-source da OpenAI fraco.
- **Grok 3** — SWE-bench 49.0% por $3/$15. Mesmo preço do Sonnet, metade da qualidade.
- **GLM-5** em LiveCode — SWE-bench forte (77.8%) mas LiveCode fraco (52.0%). Bom pra refactoring de código existente, ruim pra gerar código novo.

---

## Onde cada provedor acessa esses modelos

- **OpenRouter** — todos os modelos acima disponíveis
- **OpenCode (Go)** — Qwen 3.6/3.5 Plus recém-adicionados, zero data retention
- **DeepInfra** — DeepSeek, Qwen, GLM com preços competitivos
- **Together AI** — Llama 4, Qwen, modelos open-source
- **APIs nativas** — Anthropic (Claude), Google (Gemini), OpenAI (GPT), Moonshot (Kimi)

---

## Fontes

- [Onyx - Best LLM for Coding](https://onyx.app/best-llm-for-coding)
- [Artificial Analysis - LLM Leaderboard](https://artificialanalysis.ai/leaderboards/models)
- [PricePerToken - LLM Pricing](https://pricepertoken.com/)
- [OpenRouter - Model Pricing](https://openrouter.ai/)
- [BuildFastWithAI - Qwen 3.6 Plus](https://www.buildfastwithai.com/blogs/qwen-3-6-plus-preview-review)
- [BenchLM - Best Chinese LLMs](https://benchlm.ai/blog/posts/best-chinese-llm)
- [Latent Space - GLM-5](https://www.latent.space/p/ainews-zai-glm-5-new-sota-open-weights)
- [@opencode no X](https://x.com/opencode) — status Qwen 3.6/3.5 Plus

*Última atualização: 15 abril 2026*
