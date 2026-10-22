# Estado da implementação — 21/10/2026

## Revisão V4: fila e disponibilidade entre perguntas

O operador confirmou que o Jarvis já conecta no Render e que `/jarvis ask`
produz resposta audível na chamada real. O incidente atual é a aplicação manter
o turno ocupado após a fala porque falta `agent_response_complete`.

A revisão V4 separa fila de perguntas, sessão do provedor, drenagem local e
conclusão confirmada. Adiciona fila limitada por sala/Discord ID, prioridade do
proprietário entre perguntas aguardando e notificações de espera/cancelamento.
Uma nova pergunta pode retirar uma sessão sem conclusão após mensagem textual,
saída local drenada e nenhuma ferramenta conhecida pendente. Áudio já aceito
antes do corte drena; a sessão seguinte fica isolada. A geração anterior permanece
sem confirmação. Essa recuperação pode abandonar saída futura não sinalizada e
não conserva automaticamente o contexto remoto; não há memória de transcrições
compartilhada ou durável.

Voz mantém consentimento individual, wake/STT PT-BR experimental e follow-up na
sessão válida. Barge-in fica desabilitado por padrão; quando habilitado, exige
Discord ID do proprietário, aceite de áudio e comando explícito de parada.
Limites/cooldown e heurísticas locais reduzem eco, sem alegar AEC ou acurácia
comprovada. Nenhum detector acústico local substituiu STT sem benchmark.

Validação e deploy: [V4_CONVERSATION_VALIDATION.md](docs/V4_CONVERSATION_VALIDATION.md).
**O gate V4 permanece pendente: cinco perguntas consecutivas e ativação por voz
consentida precisam ser verificadas na chamada real.** A audição confirmada pelo
operador refere-se à versão de streaming anterior; esta revisão não executou
deploy nem audição humana.

| Verificação V4 | Resultado |
| --- | --- |
| Build, typecheck e lint Node | Passaram |
| Suíte Node | 22 arquivos; 337 testes passaram e 1 gate real explicitamente skipped |
| Suíte Python e preservação do Elysium | 78 testes e 67 subtests passaram; nenhum arquivo Python alterado |
| `git diff --check` | Passou |
| Deploy manual V4 / cinco perguntas / voz consentida | Pendentes de execução humana |
| Latência acústica PT-BR, falsos wakes, eco e custo | Sem medições V4; nenhuma promessa inferior a dois segundos |

## Histórico: revisão de reprodução progressiva

Evidência independente de produção confirmou áudio sem `agent_response_complete`:
30 eventos em 55 s; no Jarvis, `BABA0C1C` recebeu 79.360 bytes e reteve o áudio.
A revisão transmite PCM progressivamente para Opus/Discord com buffers limitados,
backpressure e cancelamento por consentimento. Conclusão da geração, fim de entrada,
drain local e término conversacional são estados separados. Recuperação sem evento
de conclusão preserva áudio válido e registra resultado não confirmado.

Pesquisa: [documentação e SDK oficial](docs/ELEVENLABS_STREAMING_RESEARCH.md).
Deploy e confirmação humana: [validação de produção](docs/STREAMING_PRODUCTION_VALIDATION.md).
**Nenhum deploy ou teste audível real foi executado nesta revisão.** A validação
final exige ouvir o Jarvis na chamada real; checks locais não aprovam esse gate.

Checks da revisão de streaming:

| Verificação | Resultado |
| --- | --- |
| Build, typecheck e lint Node | Passaram |
| `npm test` | 19 arquivos; 267 testes passaram e 1 gate real explicitamente skipped |
| `python -m pytest -q` | 78 testes e 67 subtests passaram |
| Compileall e imports do `AGENTS.md` | Passaram, sem conexão Discord |
| Elysium Python e Render Blueprint | Sem alterações nesta revisão |
| Deploy e audição real | Pendentes; nenhuma chamada real realizada nesta revisão |

Os testes novos cobrem SDK/protocolo, ordenação, cancelamento, ferramentas,
recuperação e limites. Um teste usa o player real do `@discordjs/voice` com Opus
sintético e rede simulada; isso verifica consumo local, sem provar audição humana.

## Histórico: revisão de diagnóstico de produção

Instrumentados `/jarvis join`, negociação de voz/DAVE e fluxo ElevenAgents até
playback. A revisão corrige a contagem de erro secundário no encerramento local,
detectou texto sem áudio/conclusão ausente/fechamento prematuro. Naquela revisão,
o playback aguardava conclusão explícita; essa política foi substituída pelo
streaming acima. Build, typecheck, lint e 230 testes Node passaram naquela entrega;
um gate real segue skipped. Python: 78 testes e 67 subtests passaram. Elysium não
foi alterado nesta revisão. Veja [o runbook Render](docs/RENDER_INCIDENTS.md).

O proprietário relatou Discord conectado e HTTP/WS ElevenLabs iniciados em
produção, mas nenhum áudio audível. A evidência posterior e o bloqueio local estão
registrados acima. A ausência de conclusão no provedor ainda precisa de investigação.

## Registro da entrega inicial

**Entrega técnica local implementada e verificada. Aceitação em chamada e produção
pendente.** Especificação: `../JARVIS_ELEVENAGENTS_CODEX_FULL_ACCESS.md`.

## Gates atuais

| Gate | Evidência e situação |
| --- | --- |
| A — instalação/build/lint/tipos/testes V4 | Verificação local em andamento; números anteriores não certificam a nova revisão. |
| B — saída Discord/DAVE | Conexão e resposta audível confirmadas pelo operador antes da V4; entrada de humanos, transições e reconexões ainda exigem matriz própria. |
| C — ElevenAgents real | `/jarvis ask` audível confirmado pelo operador; origem da conclusão ausente permanece sem causa demonstrada. |
| D — conversação/wake/barge-in V4 | Pendente: cinco perguntas consecutivas, PT-BR, dois participantes, consentimento, eco e cancelamento em chamada. |
| E — Render V4 | Worker existente informado pelo operador; nenhuma nova implantação desta revisão executada pelo agente. |

## Gates na entrega inicial

| Gate | Evidência e situação |
| --- | --- |
| A — instalação/build/lint/tipos/testes | Passou: 107 testes Node, 78 testes Python e 67 subtests. Um teste Node explicitamente skipped representa o gate real, não uma aprovação. |
| B — voz DAVE real | **Pendente:** sem token/IDs Discord e participantes. Spike: `npm run smoke:dave`. Opus/PCM/receiver/reconexão só comprovados com dados sintéticos. |
| C — ElevenAgents real | **Pendente:** sem agente/chave configurados. Assinatura/WS/áudio/tools têm testes de protocolo; nenhuma conversa real executada. |
| D — multiplayer/wake word real | **Pendente:** isolamento, consentimento, revogação e autorização testados localmente; pronúncia PT-BR, eco, WER, falsos wakes e latência não medidos. |
| E — produção Render | Blueprint validado pelo schema oficial; serviço Python preservado e integração opcional testada. **Nenhum deploy ou serviço pago criado.** |

## Implementado

- Worker independente em `jarvis/`, configuração isolada, dependências fixadas e lockfile.
- Slash commands `join`, `leave`, `status`, `privacy`, `consent`, `revoke`, `ask`, `tone` e `cancel` (V4).
- Consentimento por chamada, identidade Discord ID e privilégios do criador no backend.
- DAVE padrão, recepção por falante consentido, RMS/VAD, Opus, PCM e playback serializado.
- Sessões privadas ElevenAgents por usuário, formatos negociados, timeouts, TTL e limites.
- Entrada `/ask` escrita → ElevenAgents → voz, confirmada audível pelo operador na versão anterior à V4.
- V4: fila de perguntas limitada, isolamento, prioridade em espera, TTL e avisos de fila/cancelamento.
- V4: liberação por solicitação seguinte após drenagem, sem fabricar conclusão do provedor.
- V4: barge-in explícito do proprietário atrás de configuração e medições técnicas de etapas.
- Wake word experimental ElevenLabs Scribe, **desativado por padrão**; aceite adicional para envio pré-ativação e follow-up por falante.
- Client tool `search_game_info` com Brave Search opcional e limitação explícita sem chave.
- Integração opcional `JARVIS_BOT_USER_ID` no Elysium: acesso mínimo, slot e limpeza que preserva humanos/outros bots.
- CI Node separada, Blueprint aditivo, guias e System Prompt integral extraído do anexo.

## Verificações e resultados

| Comando | Resultado |
| --- | --- |
| `npm ci` | Passou; auditoria: 0 vulnerabilidades |
| `npm run build` | Passou |
| `npm run typecheck` | Passou |
| `npm run lint` | Passou |
| `npm test` | 14 arquivos, 107 passaram, 1 skipped explícito do gate real |
| `npm audit --omit=dev` | 0 vulnerabilidades |
| `python -m pytest -q` | 78 passaram e 67 subtests passaram; baseline 63 e 37 |
| `python -m compileall -q bot.py elysium` | Passou |
| Imports do `AGENTS.md` | Passaram, sem conectar ao Discord |
| `git diff --check` | Passou |
| Blueprint contra `https://render.com/schema/render.yaml.json` | Passou; serviço Python idêntico ao original |
| `npm start` sem credenciais | Código 1 esperado: só nomes de variáveis e erro sanitizado; nenhuma conexão iniciada |

Falhas locais iniciais: dependências Python ausentes foram instaladas; narrowing TS,
um lint de teste e whitespace foram corrigidos. Revisão também corrigiu cancelamento
de join pendente, completion residual, budget antes de abrir sessão, upload após
interrupção, áudio atrasado de sessão interrompida e respostas HTTP sem limite.
Não há falhas locais conhecidas. A CI foi preparada; não foi executada no GitHub.

## Limites reais e ambiente de teste

Na entrega inicial, as cinco variáveis estavam ausentes no ambiente local e em `jarvis/.env`:
`JARVIS_DISCORD_TOKEN`, `JARVIS_OWNER_USER_ID`, `JARVIS_GUILD_ID`,
`ELEVENLABS_AGENT_ID` e `ELEVENLABS_API_KEY`. Preencha só no ambiente privado;
não envie segredos em chat. As três variáveis Discord bastam para o spike DAVE.

Consulta em 21/10/2026: voice publicado 0.19.2, discord.js 14.27.0, Davey resolvido
0.1.12. A [issue #11653](https://github.com/discordjs/discord.js/issues/11653)
continua aberta e sem PR associado na página consultada. O código upstream ainda
contém a checagem de transition ID apontada no relato. Não houve reprodução aqui
por ausência de chamada real, patch especulativo, desativação de DAVE ou downgrade.
Davey carrega e cria/reset de sessão sintética funciona em Node24.19.0 Windows x64;
isso não comprova recepção de humanos. Veja a matriz [DAVE](docs/DAVE.md).

O detector experimental envia até 4 s de fala consentida por checagem ao STT externo,
inclusive antes da ativação; não é detector acústico local. Captura normal durante
playback é suprimida; V4 oferece exceção experimental restrita ao proprietário para
comando exato de parada, desabilitada por padrão. Entrada depende de fim de fala;
saída usa streaming progressivo e prioridade somente entre perguntas em espera.
Não há meta de latência comprovada.
Não há medições de WER, falsos wakes, p50/p95 ou custo/hora.

Sem banco/memória durável; sair/reiniciar exige novo consentimento. Retenção do
provedor depende da conta. Salas Elysium antigas precisam de revisão de overwrite
ou recriação normal; nenhuma migração remota foi feita. Manter uma única instância
e encerrar o processo anterior evita disputa durante implantação.

## Próximo ciclo operacional

1. Enviar o commit V4 revisado à branch do worker existente e fazer deploy manual,
   preservando uma instância e o Elysium Python. Conferir o SHA implantado.
2. Executar o [gate V4](docs/V4_CONVERSATION_VALIDATION.md): cinco perguntas
   consecutivas, fila, dois participantes, voz consentida, revogação e barge-in opcional.
3. Executar matriz [DAVE](docs/DAVE.md): humanos antes/depois, RMS por usuário,
   `/jarvis tone`, transições MLS e reconexões; registrar versões/repetições reais.
4. Conferir o agente pelo [guia ElevenLabs](docs/ELEVENLABS.md), testar `/ask`,
   voz existente, eventos, pesquisa e revogação; depois wake com dois participantes.
5. Habilitar opcionalmente o [acesso às salas](docs/ELYSIUM_INTEGRATION.md), sem
   migrar ou modificar salas já existentes sem necessidade.
6. Repetir após restart/deploy e medir latência/custo sem conteúdo. Não sincronizar
   o Blueprint para criar outro worker.

O anexo foi preservado. Não foram criados banco, serviços pagos, deploys ou
mensagens a terceiros. O guia lista todas as configurações e comandos.
