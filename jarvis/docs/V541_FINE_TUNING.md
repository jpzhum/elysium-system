# JARVIS V5.4.1 — diagnóstico, latência e personalidade

Revisão local de 22/10/2026 sobre `62b419b` (V5.4). Escopo restrito a diagnóstico
de respostas ausentes, medição de latência e auditoria de personalidade. Sem
deploy, chamadas conversacionais pagas ou alteração do agente publicado. Voz,
ferramentas, consentimento, arquitetura ElevenAgents e Elysium Python preservados.

## Evidências e correções

| Situação | Classificação | Resultado |
| --- | --- | --- |
| Cancelamento de wake contado como palavra ausente | CONFIRMADO em regressão | O detector resolve cancelamento como `false`; agora o manager verifica o cancelamento antes de incrementar `wake_rejections` ou emitir ausência de wake. |
| Falha STT perdendo correlação com captura | CONFIRMADO em regressão | `jarvis_wake_failed` conserva o incidente original da captura, motivo e duração, sem transcrição. |
| Guardrail/limite de concorrência como erro genérico | CONFIRMADO em regressão | Códigos `AGENT_GUARDRAIL_REJECTED` e `AGENT_CONCURRENCY_LIMIT`, com contadores próprios. Encerramento e fila existentes foram preservados. |
| Busca com incidente independente do turno | CONFIRMADO em regressão | `jarvis_search_result` agora usa o incidente do turno de origem, inclusive se ele for cancelado durante a pesquisa. Não altera a ferramenta nem suas permissões. |
| Média sem distribuição histórica | CONFIRMADO no código | A V5.4 guardava soma, contagem, mínimo e máximo; não é possível reconstruir mediana/p95 a partir desses agregados. Agora há janela limitada de amostras numéricas. |
| Captura incluindo o VAD final | CONFIRMADO no código | Preservado o total; adicionada janela até o último frame com voz, separada do tempo até detectar o fim. Não é medição da duração acústica exata. |
| Reconhecimento/reprodução sem duração isolada | CONFIRMADO no código | Novas medições abaixo, sem tratar métricas cumulativas como etapas somáveis. |
| Defeito na entrega de respostas do agente | NÃO REPRODUZIDO | Nenhuma causa de descarte de resposta foi demonstrada; não foram alterados lifecycle, timeouts, áudio ou decisões do agente para tentar corrigir uma hipótese. |
| Prompt publicado formal ou conflitante | NÃO CONFIRMADO | Auditoria real retornou `missing_configuration`; não foi possível ler a configuração publicada. O prompt local já contém humor seco, discordância respeitosa, Kel e respostas diretas; foi preservado. |

Não confundir ausência de wake com falha de STT, rejeição, cancelamento ou ausência
de resposta. Use o mesmo incidente para acompanhar:

| Etapa | Evidência operacional |
| --- | --- |
| Captura descartada | `jarvis_voice_capture_rejected`, `capture_rejection`; silêncio e captura curta não compram STT. |
| Wake não detectada | `jarvis_wake_detected`, `wake_detected=false`, `followup=false`; contador `wake_rejections`. |
| Follow-up válido | `wake_detected=false`, `followup=true`; caminho intencional sem wake, não uma falha. |
| Falha/limite STT | `jarvis_wake_failed`, `rejection_reason=wake_provider_failed`, `wake_rate_limited`, `wake_queue_full` ou `wake_queue_timeout`. |
| Pergunta rejeitada | `jarvis_voice_turn_rejected`, `rejection_reason`; separar aceite, disponibilidade, wake ocupado e limites de fila/orçamento. |
| Fala não reconhecida pelo agente | `AGENT_USER_TURN_MISSING`, `input_audio_finished`, `user_turn_recognized`; prazo existente de 10 s após upload. |
| Sem resposta/sem áudio do agente | `jarvis_agent_turn_failed`: `AGENT_RESPONSE_TIMEOUT`, `AGENT_EMPTY_RESPONSE` ou `AGENT_TEXT_WITHOUT_AUDIO`; não concluir falha de ferramenta só pelo tempo. |
| Rejeição explícita do provedor | `AGENT_GUARDRAIL_REJECTED` / `AGENT_CONCURRENCY_LIMIT`; contadores `agent_guardrail_rejections` / `agent_concurrency_rejections`. |
| Erro de ferramenta | `jarvis_tool_event`, `tool_stage=failed`, `tool_name` e `code`; pesquisa correlacionada também informa `search_status` em `jarvis_search_result`. |
| Áudio aceito e reproduzido | Primeiro áudio, primeiro pacote local, drain e fim do turno têm sinais distintos. Ausência de `agent_response_complete` continua com recuperação própria. |

## Medição por etapa

`/jarvis status` mantém última/média/mínimo/máximo e total desde o início do
processo. Mediana, p95 e `janela n` referem-se às últimas **até 256 amostras por
série**, em RAM. Mediana usa o centro da distribuição ordenada, com média dos
dois valores centrais para quantidade par; p95 usa nearest rank,
`ceil(0.95 × n)`. Há até 32 séries; agregados/contadores continuam limitados a
256 chaves, com admissão completa de cada agregado. Restart perde as amostras.

| Medição | Série | Interpretação |
| --- | --- | --- |
| Captura total | `voice_capture_ms` | Início da captura até entrega ao consumidor, incluindo VAD final. |
| Captura antes da cauda VAD | `voice_capture_active_ms` | Tempo até o último frame local classificado com voz; não equivale a segundos de áudio. |
| VAD/fim da fala | `voice_end_detection_ms` | Último frame com voz até finalização local. |
| Fila STT | `wake_queue_wait_ms` | Espera antes de executar a inspeção STT. |
| STT | `wake_recognition_ms` | Inspeção remota com a preparação existente, separada da fila; inclui tentativas falhas/canceladas. |
| Wake total | `wake_detection_ms` | Chamada de detecção, incluindo fila; não somar novamente com suas subetapas. |
| Fila de perguntas | `question_queue_wait_ms` | Entrada na fila até início do dispatch. |
| Conexão IA | `agent_session_open_ms` | Abertura do provedor; uma sessão reutilizada não inventa uma abertura nova. |
| Upload | `agent_audio_upload_ms` | PCM e silêncio final com pacing existente. |
| Reconhecimento IA | `agent_user_recognition_ms` | Início do envio até `user_transcript`, inclusive se o reconhecimento chegar durante o upload. Sobrepõe-se ao upload. |
| Reconhecimento depois do upload | `agent_post_upload_recognition_ms` | Somente quando o reconhecimento realmente chegar após o envio completo; ausência não significa zero nem erro. |
| Primeiro áudio IA | `agent_remote_first_audio_ms` | Fim do upload até primeiro áudio, somente quando observado nessa ordem. |
| Primeiro pacote local | `agent_first_playback_ms` | Pergunta aceita até primeiro pacote local; cumulativo. |
| Reprodução | `agent_playback_ms` | Primeiro pacote local até drain; pode incluir lacunas de geração e não comprova recepção acústica no cliente Discord. |
| Ponta a ponta | `agent_end_to_end_first_playback_ms` | Início da captura até primeiro pacote local, quando ambos foram observados. |

Os snapshots incluem `<série>_median`, `<série>_p95` e
`<série>_window_samples`. Não há gravação de áudio, texto, nomes ou IDs na janela.

### Antes/depois: resultado disponível

| Amostra de chamada real | Mediana | p95 | n |
| --- | --- | --- | --- |
| V5.4 antes | Não disponível: sem logs individuais fornecidos | Não disponível | 0 disponível nesta revisão |
| V5.4.1 depois | Não medido: sem deploy autorizado | Não medido | 0 |

Não foi possível calcular um ganho real ou indicar o maior gargalo medido. A
integração Render foi localizada, mas a conexão não estava confirmada. A coleta
real e a leitura do agente continuam pendentes; testes com relógio sintético não
substituem esse comparativo.

O código confirma um custo estrutural: a captura termina antes do STT/fila e o
PCM capturado é reenviado com pacing. Perguntas longas podem gastar duração
semelhante novamente no envio. Isso é um candidato a gargalo, não uma medição.
Acelerar o upload, cortar silêncio ou reduzir VAD sem ensaio de reconhecimento
poderia introduzir regressões e não foi feito.

Para comparar após autorização de implantação: coletar uma janela equivalente
de pelo menos 30 perguntas por versão, separar voz/texto e sessões novas/reutilizadas,
manter microfones, configuração publicada, carga e tipo de pergunta equivalentes.
Guardar somente séries numéricas, contagens, incidentes e versão. Calcular por
etapa na mesma população; registrar também erros, cancelamentos e amostras
ausentes, pois uma versão que falha cedo não deve parecer melhor só por medir
menos respostas. p95 com poucas amostras é descritivo e instável. Não somar os
p95 de etapas nem usar a média antiga como mediana da V5.4.

## Configurações exatas do ElevenLabs para revisão

Nenhuma linha desta tabela foi aplicada à conta. Conferir agente, versão/branch e
rotas de workflow efetivamente usados. Defaults/exemplos da API não são o estado
publicado. A auditoria só imprime campos permitidos, sem prompt ou credenciais.

| Campo/local exato | Revisão necessária |
| --- | --- |
| `conversation_config.agent.prompt.prompt` | Comparar com `agent-system-prompt.md`; o auditor informa igualdade exata e normalizada, sem imprimir texto. Divergência pede revisão; não prova por si só perda de personalidade. |
| `workflow.nodes.*.additional_prompt` e `workflow.nodes.*.conversation_config` | Inspecionar manualmente instruções que substituam o estilo por atendimento formal, obediência irrestrita ou ausência total de humor. Não remover regras técnicas, identidade ou consentimento. A auditoria principal não certifica esses nós. |
| `conversation_config.agent.first_message` | Preservar vazio ou override autorizado já existente; evitar saudações genéricas recorrentes. |
| `conversation_config.turn.soft_timeout_config.timeout_seconds` | Referência para este fluxo: **`-1`**, desabilitado. Não introduzir áudio de preenchimento para mascarar demora. |
| `conversation_config.turn.soft_timeout_config.use_llm_generated_message` | Referência: **`false`**, sem geração extra de filler por LLM. |
| `conversation_config.turn.turn_eagerness` | Inspecionar `patient`/`normal`/`eager`; manter o atual até medir. `normal` é candidato de comparação equilibrado; `eager` pode antecipar resposta e `patient` prolonga pausas. Não forçar um valor sem ouvir truncamento/ASR. |
| `conversation_config.turn.turn_timeout` | Manter o atual; significa retomada após silêncio do usuário, não o deadline local de reconhecimento. Não aumentar para resolver `AGENT_USER_TURN_MISSING`. |
| `conversation_config.turn.silence_end_call_timeout` | Conferir se uma duração finita explica fechamento ocioso do provedor. `-1` é uma referência possível para deixar o worker encerrar a sessão por seus limites existentes; não é mudança obrigatória nem afeta o consentimento Discord. |
| `conversation_config.turn.turn_model`, `.mode`, `.speculative_turn` e `conversation_config.vad.background_voice_detection` | Registrar os atuais; não trocar modelo de turno/VAD especulativamente. `null` no relatório significa ausente/desconhecido, não `false` nem default recomendado. |
| Security → Limits → Enable call queuing; `platform_settings.queueing_config.enabled` | O adapter atual rejeita `queue_status=waiting` com concorrência em vez de aguardar áudio de espera. Revisar desabilitação manual (`false`) se quiser refletir essa política no provedor. A fila local Discord permanece. Não habilitar espera remota supondo suporte do worker. |
| `conversation_config.conversation.client_events` | Preservar áudio, texto, `user_transcript`, `interruption`, tools e `agent_response_complete` já usados. Não remover eventos para tentar reduzir latência. |
| `conversation_config.conversation.text_only` | Preservar `false` para resposta falada. Preservar voz, modelo, ferramentas, formatos PCM e quatro variáveis de identidade/contexto. |

No ambiente configurado, após build: `npm run audit:agent`. Interpretar primeiro
`status`; `missing_configuration` não demonstra uma divergência de prompt.
`published_prompt_matches_local_normalized` ignora apenas CRLF e whitespace
externo; não verifica equivalência semântica. `runtime_behavior_verified=false`
sempre exige validação humana. Publicação continua manual e depende de autorização.

O prompt local permanece a referência para personalidade: sarcasmo seco e
inteligente, ironia leve, opinião própria, “senhor” natural, convidados bem-vindos,
afeto por Kel, precisão e humor oportuno. Conferir se prompt adicional/saudação
publicada manda sempre concordar, se apresentar ou repetir fórmulas de cortesia.
Sem ler esse conteúdo, essas possibilidades continuam hipóteses.

Referências oficiais: [fluxo de conversa](https://elevenlabs.io/docs/eleven-agents/customization/conversation-flow)
para turn-taking e filler;
[Get agent](https://elevenlabs.io/docs/api-reference/agents/get) para campos de
configuração e workflow;
[Call queueing](https://elevenlabs.io/docs/eleven-agents/guides/call-queueing)
para a fila remota e áudio de espera. O nome do campo de filler por LLM também
consta no [SDK oficial](https://github.com/elevenlabs/elevenlabs-js/blob/main/src/api/types/SoftTimeoutConfig.ts).

## Validação e rollback

Baseline: 540 testes passaram, 1 pulado, 30 arquivos. Verificação integrada final:

| Comando | Resultado |
| --- | --- |
| `npm run build` | PASSOU |
| `npm run typecheck` | PASSOU |
| `npm run lint` | PASSOU |
| `npm test` | PASSOU: 557 testes, 1 pulado, 30 arquivos |
| `git diff --check` | PASSOU |
| `npm run audit:agent` | Não validado: `missing_configuration`, saída 1 |

O teste pulado continua sendo o gate DAVE real preexistente. Regressões cobrem
mediana par/ímpar, distribuição enviesada, p95, rotação da janela e limites de
memória; reconhecimento durante áudio/cauda/após upload e reset no reuso; motivos
de rejeição, incidente da captura/STT/pesquisa e ausência de conteúdo nos logs.
As suítes existentes de streaming, playback progressivo, consentimento e fila
também passaram. Nenhum teste substitui ouvir uma chamada real.

Arquivos de execução alterados: `src/agents/{session-manager,config-audit}.ts`,
`src/audit-agent.ts`, `src/discord/{bot,voice-receiver}.ts` e
`src/observability/{metrics,status}.ts`. Testes ajustados nas suítes de turnos,
reconhecimento, receiver, integração Discord, auditoria, observabilidade e status.
Documentação: `README.md`, `docs/V5_AGENT_PROMPT.md` e este relatório. `agent-system-prompt.md` foi lido e
preservado; a personalidade local já contém os requisitos solicitados.

Em chamada autorizada, repetir voz/texto com criador e Kel, wake ausente,
follow-up, fala curta/longa, erro STT controlado, fila, erro de ferramenta, áudio
progressivo e falta de evento complete. Avaliar também derrota, decisão
arriscada, pergunta séria, conversa com Kel, mensagem carinhosa, cotidiano,
continuação e pedido técnico sem humor obrigatório. Não aprovar personalidade
apenas por contar piadas ou ocorrências de “senhor”.

Rollback após eventual implantação: voltar ao commit `62b419b` no worker
existente, com uma instância, e obter novo consentimento após restart. Como esta
revisão não modifica o agente publicado, não há mudança remota para reverter.
Qualquer futura publicação manual deve guardar sua versão anterior separadamente.
