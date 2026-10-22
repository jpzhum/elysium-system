# V5: deploy e validação de identidade, presença, pesquisa e latência

Entrega local preparada; **aceitação de produção pendente**. O operador confirmou
que a versão anterior já conecta, reproduz ElevenAgents e detecta voz. Isso não
certifica os novos comportamentos. Não houve deploy, auditoria remota do agente,
pesquisa Brave real nem audição humana desta revisão neste ambiente.

## O que foi comprovado no código

| Área | Evidência local e alteração |
| --- | --- |
| Identidade | A autoridade já vinha do Discord ID. Agora texto e voz verificam a injeção das quatro variáveis por turno, com atualização contextual na reutilização e métricas sem nomes. |
| Participantes | Faltava uma Client Tool de presença. `get_voice_participants` lê o cache atual do canal do Jarvis e usa o Discord ID da origem para identificar o falante; não usa o último comando escrito. |
| Duplicações | Eventos antigos não provam uma causa única em produção. O receptor agrupa `speaking.start` repetido durante a captura; o manager descarta o mesmo ID de captura ou janelas sobrepostas antes do STT/fila. |
| Ferramentas por voz | Havia uma corrida: a chamada de ferramenta podia ultrapassar um marcador de ASR atrás de um write assíncrono e ser negada. A entrega respeita a ordem recebida, mantendo a consulta de rede fora do bloqueio do playback. |
| Pesquisa | O backend agora distingue falta de chave, contrato inválido, cancelamento, limite, falha e fontes utilizáveis, com limites por worker. Não havia chave local para comprovar o serviço real. |
| Latência | Tempos e contadores ficam visíveis em páginas completas de `/jarvis status`. Captura, STT de wake e reenvio com pacing continuam etapas sequenciais; nenhuma melhoria acústica numérica foi medida. |

O áudio, perguntas, transcrições, nomes, Discord IDs, parâmetros e resultados das
tools não entram nos logs. Os indicadores de identidade são booleanos; as etapas
das tools usam nomes fixos e incidente do turno enquanto ele está ativo.
Presença revela apenas nome de exibição e flags mínimas ao agente, não perfis nem
autorização de áudio. O aviso de privacidade descreve esse uso.

## Configuração do agente publicado

Siga [V5_AGENT_PROMPT.md](V5_AGENT_PROMPT.md) para revisar o prompt principal e
eventuais nós de workflow. Preserve personalidade, voz, autenticação e overrides
restritos já operacionais. As quatro referências precisam estar no prompt:
`{{speaker_name}}`, `{{speaker_is_creator}}`, `{{active_game}}`, `{{room_context}}`.
Um valor default no painel não comprova o uso no prompt. `active_game` permanece
`não informado` sem contexto explícito; nenhum intent de presença foi adicionado.

Cadastre e associe as duas ferramentas como **Client**, com **Wait for response**:

| Nome exato | Parâmetros |
| --- | --- |
| `get_voice_participants` | Objeto vazio; [schema](get-voice-participants.schema.json). Sem seletores de usuário/canal, IDs ou permissões. |
| `search_game_info` | Strings obrigatórias `game` e `query`; [schema](search-game-info.schema.json). Sem campos adicionais. |

Habilite `audio`, `user_transcript`, `agent_response`, `agent_response_complete`,
`interruption`, `client_tool_call`, `agent_tool_request` e `agent_tool_response`.
Preserve também `client_error` e os demais eventos usados pelo agente existente.
Ferramentas pendentes impedem declarar disponibilidade por drenagem como se o
provedor tivesse concluído. `agent_response_complete` continua um sinal explícito,
sem ser requisito para iniciar áudio progressivo. Publicar apenas o código Node
não cadastra ferramentas nem altera o prompt remoto.

No shell do worker após o build:

```console
npm run audit:agent
```

A auditoria faz somente GET à origem oficial; não imprime configurações brutas.
`status: "ok"` informa leitura bem-sucedida. Exija
`configuration_checks_passed: true` para o contrato estático e revise manualmente
workflows ou permissão de override ausente na API quando
`manual_review_required: true`. Código de saída 1 indica checks
incompletos, falha de leitura/configuração ou revisão manual, não um crash do
worker. `runtime_behavior_verified` permanece false até nos relatórios estáticos
aprovados. Confirme a versão publicada efetivamente selecionada pela conversa.
Caso a conta use branches/versions adicionais, revise cada rota no dashboard;
o auditor cobre somente a configuração principal devolvida pela API.

## Variáveis e deploy no worker existente

**Nenhuma variável obrigatória nova.** Preserve todas as variáveis e limites
existentes. Para pesquisa, configure a variável opcional já suportada
`JARVIS_SEARCH_API_KEY` com uma chave **Brave Search** no Environment do **worker
Jarvis**, sem colocá-la no prompt, Client Tool, serviço Python, chat ou Git.
O estado do ambiente Render ainda precisa ser conferido; a chave estava ausente
apenas no ambiente local examinado. Sem chave, `/status` e a tool informam essa
limitação e retornam fontes vazias, sem simular uma pesquisa.

1. Envie o commit revisado para a branch conectada ao worker (`git push origin main`
   quando essa for a branch configurada).
2. No Background Worker Jarvis existente, faça deploy manual desse commit e
   confira o SHA implantado. Preserve `rootDir: jarvis`, build
   `npm ci && npm run build`, start `npm run start`, plano/região e uma instância.
3. Aguarde o processo anterior encerrar. Não crie outro worker com o mesmo bot.
   O serviço Elysium Python e o Blueprint não foram alterados por esta revisão.
4. Confira `jarvis_ready` com `diagnostics_version: 6` e o booleano
   `search_key_configured`. Execute a auditoria acima e corrija no dashboard
   somente os campos reprovados antes dos testes de comportamento.
5. Entre na call, execute `/jarvis join`, leia `/jarvis privacy` e renove o
   consentimento de cada conta. Voz exige o aceite específico de áudio e
   `JARVIS_VOICE_INPUT=elevenlabs-stt`, já existente. Estar na sala não dá esse aceite.

Não desative DAVE nem acrescente intents privilegiados para esta validação.
Em regressão, faça rollback do worker ao commit anterior e preserve a configuração
remota compatível; mudanças de prompt/tools no dashboard têm revisão separada.

## Matriz obrigatória em chamada real

Use criador e convidado com Discord IDs distintos, de preferência com o mesmo
nome de exibição em uma rodada. Registre apenas SHA/versão, incidentes, resultados
booleanos e tempos técnicos; não publique nomes, áudio ou perguntas reais.

| Teste | Resultado necessário |
| --- | --- |
| Criador e convidado por texto | Cada conta pergunta quem está falando. A resposta identifica a origem e distingue criador/convidado; a alegação verbal/escrita de propriedade não muda a flag. |
| Criador e convidado por voz | Após consentimento, cada um diz uma pergunta com wake. Ouça a resposta à pergunta, sem confundir saudação com reconhecimento. Alterne as contas sem compartilhar sessão. |
| Presença atual | Peça quem está na call; entre/saia com outra conta e repita. A tool deve refletir o cache atual e a origem do turno; bots são identificados. Não atribua consentimento à mera presença. |
| Pesquisa real | Com Brave configurado, pergunte um fato de jogo verificável. Confira tool recebida/iniciada/concluída, `search_success`, `source_count > 0` e fontes no resultado/resposta. Uma fala genérica ou `client_tools_completed` sozinho não comprova busca. |
| Falta de chave ou limite | Sem chave, a resposta admite indisponibilidade e `search_missing_key` cresce. Consultas muito próximas podem retornar `rate_limited`; não há fontes inventadas nem retries em loop. |
| Cinco perguntas consecutivas | Faça cinco capturas distintas, incluindo repetição intencional da mesma pergunta. Cada fala válida entra uma vez; uma duplicata da mesma janela não ocupa outra posição. Confira captura/wake/fila e respostas ou motivo específico de limite. |
| Revogação e cancelamento | Revogue durante upload, playback e pesquisa; a saída e novos envios daquele consentimento param. Cancelamento, saída e desconexão não deixam tools antigas consultarem outra sala. |
| Fila e prioridade | Duas contas perguntam durante uma resposta. A fila fica limitada, a prioridade do criador vale entre perguntas aguardando e nenhum áudio de outro falante é misturado. |
| Sessão sem conclusão | Se o evento continuar ausente, o áudio deve começar normalmente; registre `turn_completion_missing` e a recuperação sem declarar geração concluída. Não force esse caso alterando protocolo/segurança em produção. |

O roster contém somente presentes; não existe histórico para afirmar quem está
ausente. `available: false` significa consulta não autorizada/indisponível.
`complete: false` indica recorte: até 100 nomes e 14 KiB serializados, mantendo
`current_speaker`. O agente deve reconhecer o recorte, sem inventar participantes.

## Comparação de latência antes/depois

Siga [VOICE_CAPTURE_LATENCY.md](VOICE_CAPTURE_LATENCY.md). Em cada versão faça
cinco perguntas equivalentes, com os mesmos limites, agente e condições de rede;
anote separadamente sessão nova e reutilizada. `/jarvis status` mostra última,
média, mínima, máxima e número de amostras em ms, por processo. `sem amostras`
nunca significa zero. Os contadores reiniciam no deploy.

| Etapa | Métrica ou sinal |
| --- | --- |
| Captura Discord e VAD | `voice_capture_ms`, `voice_end_detection_ms`; log `jarvis_voice_captured` |
| Wake | `wake_queue_wait_ms`, `wake_recognition_ms`, `wake_detection_ms` |
| Fila de perguntas | `question_queue_wait_ms`, `turn_queue_depth` |
| Abertura/reutilização | `agent_session_open_ms`, `agent_session_reused`, `session_reused` |
| Upload | `agent_audio_upload_ms`, frames `agent_input_source_chunks` / `agent_input_silence_chunks` |
| Reconhecimento na sessão | `jarvis_agent_user_turn_recognized`, `agent_user_turns_recognized` |
| Primeiro áudio gerado | `agent_first_audio_ms` a partir da pergunta aceita |
| Primeiro pacote local | `agent_first_playback_ms`; não comprova quando o humano ouviu |
| Próxima disponibilidade | `next_question_ready_ms`, sinal de drenagem local e fila |

Os tempos de primeiro áudio/pacote são cumulativos; não some médias cumulativas
como etapas independentes. Anote a percepção humana separadamente, sem gravar
conteúdo. Pacing de 20 ms e silêncio final de 800 ms continuam preservados.
Não há promessa de menos de dois segundos nem ganho de produção calculado aqui.

## Registro desta revisão

Testes automatizados cobrem identidade texto/voz, dois participantes, cache vivo,
ferramentas antes de ASR, contexto reutilizado, dedup/debounce, pergunta legítima
repetida, revogação, desconexão, backpressure, schema, falta de chave, fontes com
HTTP simulado, timeout e limites. O teste marcado skipped continua representando
o gate humano. Os resultados finais dos checks ficam em
[IMPLEMENTATION_STATUS.md](../IMPLEMENTATION_STATUS.md).

**A missão V5 só poderá ser aceita após preencher a matriz real acima:** duas
contas reconhecidas, texto correto, participantes atuais, busca com fontes, cinco
perguntas sem duplicação indevida e comparação de latência. Build e testes locais
não preenchem esses resultados.
