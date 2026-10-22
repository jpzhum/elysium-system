# Estado da implementação — 21/10/2026

## Revisão de diagnóstico de produção

Instrumentados `/jarvis join`, negociação de voz/DAVE e fluxo ElevenAgents até
playback. A revisão corrige a contagem de erro secundário no encerramento local,
detecta texto sem áudio/conclusão ausente/fechamento prematuro e só libera áudio
após conclusão explícita válida. Build, typecheck, lint e 230 testes Node passaram;
um gate real segue skipped. Python: 78 testes e 67 subtests passaram. Elysium não
foi alterado nesta revisão. Veja [o runbook Render](docs/RENDER_INCIDENTS.md).

O proprietário relatou Discord conectado e HTTP/WS ElevenLabs iniciados em
produção, mas nenhum áudio audível. Os contadores anteriores não determinam a
causa. A nova instrumentação precisa de outra tentativa no Render; esta revisão
não fez deploy nem comprovou a conexão de voz ou resposta audível real.

## Registro da entrega inicial

**Entrega técnica local implementada e verificada. Aceitação em chamada e produção
pendente.** Especificação: `../JARVIS_ELEVENAGENTS_CODEX_FULL_ACCESS.md`.

## Gates

| Gate | Evidência e situação |
| --- | --- |
| A — instalação/build/lint/tipos/testes | Passou: 107 testes Node, 78 testes Python e 67 subtests. Um teste Node explicitamente skipped representa o gate real, não uma aprovação. |
| B — voz DAVE real | **Pendente:** sem token/IDs Discord e participantes. Spike: `npm run smoke:dave`. Opus/PCM/receiver/reconexão só comprovados com dados sintéticos. |
| C — ElevenAgents real | **Pendente:** sem agente/chave configurados. Assinatura/WS/áudio/tools têm testes de protocolo; nenhuma conversa real executada. |
| D — multiplayer/wake word real | **Pendente:** isolamento, consentimento, revogação e autorização testados localmente; pronúncia PT-BR, eco, WER, falsos wakes e latência não medidos. |
| E — produção Render | Blueprint validado pelo schema oficial; serviço Python preservado e integração opcional testada. **Nenhum deploy ou serviço pago criado.** |

## Implementado

- Worker independente em `jarvis/`, configuração isolada, dependências fixadas e lockfile.
- Slash commands `join`, `leave`, `status`, `privacy`, `consent`, `revoke`, `ask` e `tone`.
- Consentimento por chamada, identidade Discord ID e privilégios do criador no backend.
- DAVE padrão, recepção por falante consentido, RMS/VAD, Opus, PCM e playback serializado.
- Sessões privadas ElevenAgents por usuário, formatos negociados, timeouts, TTL e limites.
- Fallback `/ask` escrito → ElevenAgents → voz, aguardando teste real.
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

## Bloqueios e limites reais

As cinco variáveis estão ausentes no ambiente e em `jarvis/.env`:
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
inclusive antes da ativação; não é detector acústico local. Captura durante playback
é suprimida, sem barge-in. Entrada depende de fim de fala; saída é acumulada até
conclusão da resposta para arbitrar playback. A meta de 4 s não está comprovada.
Não há medições de WER, falsos wakes, p50/p95 ou custo/hora.

Sem banco/memória durável; sair/reiniciar exige novo consentimento. Retenção do
provedor depende da conta. Salas Elysium antigas precisam de revisão de overwrite
ou recriação normal; nenhuma migração remota foi feita. Manter uma única instância
e encerrar o processo anterior evita disputa durante implantação.

## Próximo ciclo operacional

1. Configurar bot separado e variáveis privadas pelo [README](README.md).
2. Executar matriz [DAVE](docs/DAVE.md): humanos antes/depois, RMS por usuário,
   `/jarvis tone`, transições MLS e reconexões; registrar versões/repetições reais.
3. Configurar o agente pelo [guia ElevenLabs](docs/ELEVENLABS.md), testar `/ask`,
   voz existente, eventos, pesquisa e revogação; depois wake com dois participantes.
4. Habilitar opcionalmente o [acesso às salas](docs/ELYSIUM_INTEGRATION.md).
5. Revisar plano/região/custos Render e autorizar criação/deploy manual. Sincronizar
   o Blueprint pode criar worker pago mesmo com deploy automático desligado.
6. Repetir o teste operacional após restart/deploy e medir latência/custo sem conteúdo.

O anexo foi preservado. Não foram criados banco, serviços pagos, deploys ou
mensagens a terceiros. O guia lista todas as configurações e comandos.
