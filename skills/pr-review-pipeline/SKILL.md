---
name: pr-review-pipeline
description: Pipeline de review autônomo de PR do SEAL (Flutter, Vue, backend antigo, backend novo). Roda em sequência o checklist do OCR, o contexto da PR par do outro repo, a skill de review do repo, a lente de arquitetura e domínio, o inventário de regras de negócio (o que está e o que não está documentado), os testes no padrão /tdd, a cobertura dos cenários da US e a cobrança de documentação; consolida tudo num único resultado JSON com prompt de correção por achado. Não posta nada — quem publica é o sensor.
---

# PR Review Pipeline

Você é a etapa de **análise** do review automático do SEAL. Roda sem humano: nunca pergunte nada, nunca
poste, vote, edite arquivo, commite ou faça push. Tudo que for publicado sai do bloco JSON final — o
sensor lê esse bloco, posta na PR, vota e avisa no Telegram e no painel.

Idioma de todo texto que vai para a PR: **português**, direto, citando `arquivo:linha`.

## Entrada

Leia primeiro, no diretório atual (um worktree no commit da PR):

- `.seal-review/context.json` — repo, stack, `repoSkill`, `prId`, `prUrl`, `mode` (`first-review` | `re-review`),
  `headSha`, `previousSha`, `mergeBase`, `diffCommand`, `reReviewDiffCommand`, `workItems`, `ocrBin`, `targetGate`, `pair[]`,
  `repoSkills[]` (nome + descrição das skills do repo) e `docsTree` (o que existe em `docs/`).
- `.seal-review/us.md` — descrição e critérios de aceite dos work items vinculados (já em texto).

O diff da PR é `diffCommand`. Em `re-review`, o foco é `reReviewDiffCommand` (o que mudou desde a última
revisão), mas os achados continuam valendo contra o estado final do código.

Guarde os artefatos intermediários em `.seal-review/` (é descartável).

## PR grande: modo parte e modo consolidação

Quando o diff revisável (sem lockfile, screenshot, golden e build) passa de ~1.500 linhas, o sensor divide a PR
em partes por área e roda uma task por parte, depois uma consolidação. O campo `review` do contexto diz o modo:

- `single` — PR normal: siga o grafo inteiro abaixo.
- `part` — **Modo parte**. O contexto é `.seal-review/part-<id>.json`, e `part` traz `kind`, `label`, `paths` e
  `diffCommand` (o diff **só** desses arquivos). Rode apenas as etapas que dependem do código da parte:
  1 (checklist OCR dos arquivos da parte), 3 (skill do repo sobre esse diff), 4 (arquitetura), 5 (regras de
  negócio) e 6 (testes). **Não** rode par, US nem cobrança de documentação da PR (isso é da consolidação).
  Leia código fora da parte só para entender um uso ou contrato; não reporte achado fora dela.
  Com `kind: "docs"`, a revisão é leve: o texto bate com o código? contradiz o `CLAUDE.md`/`CONTEXT.md`? promete
  comportamento que não existe? Nada de OCR, regras de negócio ou testes.
  Grave arquivos intermediários só em `.seal-review/part-<id>/`. Emita o bloco final normal, com `findings`
  e um `summary` de 1 frase sobre a parte (`usCoverage` e `pairedPrs` vazios).
- `consolidate-parts` — **Modo consolidação**. Não revise o diff de novo. Leia `partsFindingsFile`, que traz os
  achados de cada parte (e quais partes falharam), e rode as etapas da PR inteira: 2 (par), 7 (cenários da US —
  os testes podem estar em qualquer parte; use `diffCommand` com `--stat` e leia só os testes que precisar), 8
  (documentação) e 9 (consolidação: deduplique achados repetidos entre partes, verifique cada BLOCKER lendo o
  código, remova o que já está postado e aberto). Parte com `ok: false` entra no `summary` como "parte N (label)
  não foi revisada" — não invente achados dela. O bloco final é o de sempre, com todos os achados da PR.

## Grafo de comportamento

Siga este grafo. Cada nó só avança com a saída do anterior; nenhum nó posta nada.

```mermaid
flowchart TD
    A[Ler context.json + us.md] --> G{targetGate no contexto?}
    G -- sim --> G1[Registrar: o sensor publica o gate<br/>não repetir como achado]
    G -- não --> B
    G1 --> B[1. Checklist OCR<br/>ocr delegate, sem LLM]
    B --> P{pair vazio?}
    P -- não --> P1[2. Ler só o contrato da PR par<br/>fatos com arquivo:linha em pair.md]
    P -- sim --> R
    P1 --> R[3. Skill do repo em modo só-relatório<br/>+ ocr-rules.md + pair.md]
    R --> AR[4. Lente de arquitetura e domínio<br/>só sobre o diff]
    AR --> BR[5. Regras de negócio<br/>inventário em rules.md]
    BR --> BR1{regra tem fonte?}
    BR1 -- contradiz a fonte --> BR2[achado: divergência de regra]
    BR1 -- sem fonte --> BR3[acumula como regra tácita]
    BR1 -- ok --> T
    BR2 --> T
    BR3 --> T[6. Testes no padrão /tdd<br/>por regra, bordas, regressão, qualidade]
    T --> U{US vinculada?}
    U -- não --> U0[doc-request: vincular US]
    U -- sim --> UC{tem critério de aceite?}
    UC -- não --> U1[doc-request: pedir critérios<br/>não deduzir do código]
    UC -- sim --> U2[7. Cenários da US × testes<br/>test-gap por cenário sem teste]
    U0 --> D
    U1 --> D
    U2 --> D[8. Cobrança de documentação<br/>inclui 1 achado agregado com as regras tácitas]
    D --> C[9. Consolidar]
    C --> C1[deduplicar por fonte]
    C1 --> C2[derrubar/rebaixar o que o par garante]
    C2 --> C3{BLOCKER tem cenário<br/>concreto que quebra?}
    C3 -- não --> C4[rebaixar para WARNING]
    C3 -- sim --> C5
    C4 --> C5[remover o que já está postado e aberto]
    C5 --> C7[fixPrompt autocontido em todo achado]
    C7 --> V[Veredito + blockingReason] --> O[Bloco SEAL_REVIEW_JSON]
```

Regras que valem em todos os nós:
- **Evidência antes de severidade**: BLOCKER exige o cenário concreto (entrada → resultado errado) e o
  `arquivo:linha` onde ele nasce. Sem isso é WARNING ou pergunta (`doc-request`).
- **Não inventar regra de negócio**: se o comportamento certo não está na US, no contrato do par nem nas
  regras do repo, a saída é `doc-request`, nunca "deveria ser assim".
- **Só o diff**: não reportar dívida de código que a PR não tocou.
- **Custo**: não reler o diff inteiro em cada etapa; cada etapa lê o que precisa (o checklist do OCR, o
  contrato do par, os testes da US).

## Gate de branch de destino

O sensor já verifica a branch de destino de forma determinística (trabalho → release atual; só
`release/*`, `hotfix/*` e `gmud/*` entram em `main`) e publica o achado sozinho. Se `targetGate` vier
preenchido no contexto, **não** crie outro achado para isso; só leve em conta no resumo e no veredito.

## Etapas (em ordem — cada uma alimenta a próxima)

### 1. Checklist do OCR (sem LLM)

Use o binário de `ocrBin` do contexto (caminho absoluto; o `PATH` do executor não enxerga o nvm):

```bash
<ocrBin> delegate preview --from <mergeBase> --to <headSha>
<ocrBin> delegate rule <arquivos revisáveis listados no preview>
```

Salve a saída em `.seal-review/ocr-rules.md`. É um **checklist extra** por arquivo, não uma segunda
revisão: não reveja o diff inteiro por causa dele. Se `ocrBin` vier `null` ou o comando falhar, registre `ocr:skipped` em
`stagesRun` e siga.

### 2. Contexto da PR par (quando `pair[]` não está vazio)

O par é o outro lado da mesma entrega (Flutter ↔ backend antigo, Vue ↔ backend novo). Para cada item de
`pair[]`, rode `diffCommand` com `--stat` e leia **só o que é contrato**: rotas, DTOs/payloads, tipos de
resposta, validações de fechamento, feature flags, mensagens de erro. Use `showFileCommand` para ler um
arquivo inteiro do par.

Escreva `.seal-review/pair.md` com fatos verificados, um por linha, com `arquivo:linha` do par — por
exemplo "o backend devolve `dias_disponiveis` ordenado e sem vazio (`motor-de-regras.ts:84`)". Esses fatos
servem para **derrubar** achados que o outro lado já garante e para **levantar** divergência de contrato
(campo que um manda e o outro não lê, nome diferente, status HTTP diferente do tratado).

Se a PR par aponta para uma release diferente desta PR (`targetBranch` de cada lado) e uma depende do
contrato da outra, isso é achado `WARNING`: as duas precisam sair juntas.

Sem par: registre `pair:none` e siga. Não invente contrato do outro lado.

### 3. Skill de review do repo

Invoque a skill `repoSkill` do contexto (`vue-review`, `smart-review`, `yh-smart-review`…) sobre o diff
`mergeBase..headSha`. Se `repoSkillPath` vier preenchido, **leia esse arquivo e siga-o** em vez de chamar a
skill pelo nome (caminhos relativos citados nele partem da pasta do arquivo). Para o `code-review`, o ponto
fixo é `mergeBase` e os padrões do repo são o `CLAUDE.md` e o `CONTEXT.md`. Regras sobrepostas às da skill:

- **Modo só-relatório**: pule toda fase de postar, votar, commitar report, aplicar fix ou migrar código.
  Onde ela pediria confirmação, siga sem postar.
- Profundidade máxima que ela oferecer (ex.: `smart-review` → escopo Completa, tier Deep), exceto passos
  que editem arquivo.
- Passe como contexto adicional `.seal-review/ocr-rules.md` e `.seal-review/pair.md`.
- Você já está no código da PR: não troque de branch.

Colete os achados dela (severidade, arquivo, linha, problema, regra, sugestão).

### 4. Lente de arquitetura e domínio (só sobre o diff)

Checklist destilado de `codebase-design`, `improve-codebase-architecture` e `domain-modeling`. Aplique
**apenas ao código que a PR cria ou altera** — a análise do repo inteiro é a rotina semanal, não esta.
Use o vocabulário exato: **módulo**, **interface**, **profundidade**, **seam**, **adapter**.

Design de módulo (`codebase-design`):
- **Módulo raso novo**: interface quase do tamanho da implementação, ou função que só repassa. Teste da
  deleção: se apagar o módulo não espalha complexidade pelos chamadores, ele não se paga.
- **Seam hipotético**: interface/abstração nova com um único adapter e nada que varie através dela.
- **Teste passando por trás da interface**: teste novo que importa detalhe interno em vez de exercitar
  a interface do módulo.
- **Dependência criada dentro** (instanciar cliente/serviço no corpo) em vez de recebida; efeito
  colateral onde caberia retornar um valor.

Arquitetura (`improve-codebase-architecture`):
- **Perda de localidade**: entender o conceito que a PR mexe exige pular por muitos módulos pequenos;
  função pura extraída "para testar" enquanto o bug real mora em como ela é chamada.
- **Vazamento pelo seam**: um módulo passou a depender de detalhe interno de outro.
- **Contradição com ADR**: se o repo tem `docs/adr/` ou `docs/architecture/`, a PR não pode contrariar
  uma decisão registrada sem dizer por quê.

Domínio (`domain-modeling`):
- **Termo em conflito com o glossário** (`CONTEXT.md`, `CONTEXT-MAP.md` ou o glossário do repo): o
  código chama de X o que o glossário chama de Y.
- **Nome vago ou sobrecarregado** para um conceito de negócio (ex.: "account" quando pode ser Cliente ou
  Usuário) — proponha o termo canônico.
- **Conceito de domínio novo** que não está no glossário → `doc-request` para registrar (só se o repo
  tiver glossário).
- **Decisão difícil de reverter, surpreendente sem contexto e fruto de trade-off real** → `doc-request`
  sugerindo ADR. Os três critérios juntos; faltando um, não peça ADR.

Severidade: em geral `WARNING` ou `NIT`. `BLOCKER` só quando o problema de design produz um defeito
concreto. `sources: ["architecture"]`.

### 5. Regras de negócio (o que está e o que não está documentado)

Objetivo: nenhuma regra de negócio da PR fica só na cabeça de quem escreveu.

1. **Inventário**: liste em `.seal-review/rules.md` toda regra que o diff cria ou altera. Regra é qualquer
   decisão que o PO poderia mudar amanhã: condição de elegibilidade, limite/percentual/número, transição de
   estado, permissão ou módulo/flag que libera algo, cálculo (preço, desconto, frete, total), valor padrão,
   prazo/data, ordenação que tem significado, tratamento de erro que muda o que o usuário vê.
   Uma linha por regra: `arquivo:linha` · o que o código faz, em linguagem de negócio · fonte.
2. **Fonte de cada regra**, nesta ordem: critério de aceite em `us.md`, spec/doc do repo (procure em
   `docsTree`: `docs/specs/`, `docs/features/`, `docs/regras-dados/`, `docs/modules/`…), contrato da PR par
   (`pair.md`), descrição da PR. Classifique: **documentada**, **parcial** (o doc existe, mas não cobre este
   caso) ou **tácita** (só existe no código).
3. **Divergência** entre código e fonte → achado próprio `kind: "code"`, em geral `BLOCKER` (a regra
   implementada não é a combinada). Diga as duas versões lado a lado.
4. **Regra duplicada**: a mesma regra calculada em mais de um lugar do diff (ou do diff com o que já existia)
   → `WARNING`: regra de negócio vive num lugar só.
5. **Regras tácitas e parciais** → **um único** achado `kind: "doc-request"`, `WARNING`, com a lista de todas
   (arquivo:linha + regra em linguagem de negócio). O `fixPrompt` traz o **texto pronto** para registrar e o
   **destino segundo a convenção do repo**:
   - se `repoSkills` tem uma skill de documentação (ex.: `feature-docs`), o prompt manda usá-la
     (`/feature-docs <tela>`), com as regras como insumo;
   - senão, o prompt aponta a pasta de `docsTree` onde o repo já registra esse tipo de coisa (ex.:
     `docs/regras-dados/` no backend novo, `docs/features/` no Vue, `docs/modules/` no Flutter) e o arquivo
     do domínio que já existe, em vez de criar pasta nova;
   - se não há pasta nenhuma que sirva, peça o registro na descrição da PR e na US, e diga isso.
   Regra que vale para o produto e não só para o código também deve ir para os critérios da US.

`sources: ["business-rules"]`.

### 6. Testes (padrão `/tdd`)

Julgue os testes da PR pelos critérios da skill `tdd`, resumidos aqui:

- **Pela interface pública (seam)**: o teste exercita o módulo por onde o chamador o usa. Teste que chama
  método privado, lê estado interno ou verifica por canal lateral (consultar o banco em vez da interface)
  → `WARNING`.
- **Comportamento, não implementação**: nome e asserção dizem O QUÊ o usuário/chamador obtém, não COMO.
  Asserção em quantidade/ordem de chamadas de colaborador interno é sinal de acoplamento.
- **Mock só na fronteira**: API externa, banco (de preferência banco de teste), tempo, aleatoriedade,
  sistema de arquivos. Mock de módulo/classe do próprio repo → `WARNING`.
- **Sem tautologia**: o valor esperado vem de fonte independente (literal conhecido, exemplo resolvido, spec),
  nunca recalculado do jeito que o código calcula → `WARNING`.
- **Uma asserção lógica por teste**, e teste determinístico (sem relógio real, sem ordem implícita).

E cobre o que falta:

- **Teste por regra**: cada regra do inventário da etapa 5 precisa de um teste que a exercite → `test-gap`.
- **Casos de borda derivados da regra**: o valor exato do limite (`==`), um abaixo e um acima; vazio/nulo;
  caminho de erro → `test-gap`.
- **Regressão em bug**: PR de correção precisa de um teste que **falharia sem o fix**. Leia o teste e o diff e
  diga por que ele falharia; se não falharia, é `test-gap` `BLOCKER`.
- **PR sem nenhum teste** para regra nova ou bug corrigido → `BLOCKER`.

O `fixPrompt` de cada achado de teste manda usar a skill de testes do repo quando `repoSkills` tiver uma
(ex.: `/unit-test`, `/acceptance-test`, `smart-test-review`), descreve o cenário em Dado/Quando/Então e diz
em qual arquivo de teste existente ele entra.

`sources: ["tests"]`.

### 7. Cobertura dos cenários da US

A partir de `.seal-review/us.md`:

1. Extraia os **cenários** que os critérios de aceite descrevem, um por comportamento observável, escritos em
   **Dado / Quando / Então**. Para bug, o cenário é "o defeito descrito não acontece mais". Se a US não tem
   critério mas a Task filha tem, use os da Task e diga isso em `source`.
2. Para cada cenário, procure no diff (e nos testes que ele toca) um teste que o exercite de verdade —
   asserção sobre o comportamento, não só um teste que passa pelo arquivo. `test` = `arquivo:linha` do teste.
3. Para cenário sem teste, preencha `where`: o arquivo de teste existente onde ele deve entrar (siga o
   padrão do repo; só proponha arquivo novo se não houver onde encaixar).
4. Preencha `usCoverage` com **todos** os cenários (cobertos e não cobertos). **Não crie achado individual
   para cenário da US sem teste**: o sensor monta um único comentário com todos os descobertos e o prompt
   que escreve os testes. Não deixe cenário descoberto de fora da lista: é ela que vira a cobrança.

Casos de borda — cobre em vez de inventar:
- **Sem work item vinculado** → achado `kind: "doc-request"`, `WARNING`: vincular a US/bug na PR.
- **Work item sem critério de aceite** (nem na US, nem na Task) → `doc-request`, `WARNING`: pedir os
  critérios; não deduza cenários do código (isso só confirmaria o que o código faz, não o que deveria
  fazer). `usCoverage.total = 0`.

### 8. Cobrança de documentação

Achado `kind: "doc-request"` (em geral `WARNING`, `NIT` se cosmético) quando a intenção não dá para inferir
do código, da US nem da descrição da PR. Exemplos:
- regra de negócio / número mágico sem fonte (spec, US, regra do backend);
- mudança de contrato de API sem nota na descrição da PR nem no doc do repo;
- mudança de comportamento silenciosa (algo que existia deixou de acontecer) sem explicação;
- descrição da PR vazia ou que não diz o problema e a solução.

Peça o que falta e onde registrar. Não peça comentário no código se a regra do repo proíbe comentários —
nesse caso peça na descrição da PR, na US ou no doc do repo.

### 9. Consolidação (obrigatória)

1. **Deduplique** achados que mais de uma etapa levantou; `sources` registra quem achou
   (`ocr`, `repo-skill`, `architecture`, `business-rules`, `tests`, `us-coverage`, `doc`, `pair`).
2. **Checagem com o par**: derrube ou rebaixe o achado que um fato de `pair.md` torna impossível, e diga
   isso no `body` quando rebaixar.
3. **Verificação adversarial de cada BLOCKER**: releia o código e tente refutar. Se não conseguir mostrar
   o cenário concreto que quebra, rebaixe para `WARNING`.
4. Leia as threads existentes da PR (ferramenta de leitura do azure-devops), **de qualquer autor**, e
   **não repita** ponto já levantado que continua aberto; só entra achado novo ou regressão. Vale para
   primeira revisão e re-revisão.
6. Todo achado tem `fixPrompt` **autocontido**: repo, arquivo(s), o que mudar, o que não tocar e os comandos
   de verificação do repo (ex.: `npx vue-tsc --build`, `npm test`, `flutter test <arquivo>`). Deve dar para
   colar num agente sem ler a PR.

Veredito — **a regra é do sensor e você a revisa**:
- O sensor aplica: qualquer achado publicado deixa a PR em **Aguardando autor** (-5); zero achados, **Aprovado** (10).
- Você revisa essa regra achado por achado: cada um precisa justificar, sozinho, não aprovar a PR. Se não
  justifica, não publique. O que é só gosto pessoal não entra.
- Escreva `blockingReason`: **uma frase**, direta, dizendo por que a PR não pode ser aprovada agora
  (ex.: "o fechamento aceita data fora da janela do motor-de-regras e não há teste do cenário da US"). Vazio
  quando não há achados. É o texto do comentário de resumo.
- `verdict` é a sua opinião independente; se ela divergir da regra, o sensor avisa no Telegram.

## Saída

**Primeiro grave o resultado em arquivo:** use a ferramenta Write para salvar o objeto JSON (só o JSON, sem os
delimitadores) no caminho `resultFile` do contexto (`.seal-review/result.json`, ou
`.seal-review/part-<id>/result.json` no modo parte). É esse arquivo que o sensor lê: a saída de texto pode ser
cortada em resultado grande. Depois, sua mensagem final termina **exatamente** com o mesmo conteúdo neste bloco
(JSON válido, sem comentários):

```
<<<SEAL_REVIEW_JSON
{
  "verdict": "approved | needs-work",
  "blockingReason": "uma frase: por que não dá para aprovar agora (vazio se não há achados)",
  "summary": "1–3 frases: o que a PR faz e o principal risco",
  "stagesRun": ["ocr", "pair", "repo-skill", "architecture", "business-rules", "tests", "us-coverage", "doc", "consolidate"],
  "usCoverage": {
    "total": 3,
    "covered": 2,
    "source": "US 20205 (critérios na Task 20214)",
    "note": "falta o cenário de ...",
    "scenarios": [
      { "id": "C1", "text": "Dado ..., Quando ..., Então ...", "covered": true, "test": "test/foo_test.dart:42" },
      { "id": "C3", "text": "Dado ..., Quando ..., Então ...", "covered": false, "where": "test/foo_test.dart" }
    ]
  },
  "pairedPrs": [{ "repo": "api-nova", "prId": 10104, "facts": 4 }],
  "findings": [
    {
      "severity": "BLOCKER | WARNING | NIT",
      "kind": "code | test-gap | doc-request",
      "file": "src/caminho/arquivo.ts",
      "line": 42,
      "endLine": 44,
      "title": "frase curta com o defeito",
      "body": "problema concreto e o cenário que quebra",
      "rule": "regra do repo violada (opcional)",
      "suggestion": "o que fazer",
      "fixPrompt": "prompt autocontido de correção",
      "sources": ["repo-skill", "ocr"]
    }
  ]
}
SEAL_REVIEW_JSON>>>
```

- `file` é relativo à raiz do repo; `line` é linha do arquivo **no `headSha`**. Achado sem linha
  (ex.: vincular US) vai com `file: null, line: null`.
- Se uma etapa falhar, registre no `stagesRun` como `<etapa>:failed` e siga com as outras — um resultado
  parcial é melhor que nenhum. Só não emita o bloco se não conseguir ler o diff.
