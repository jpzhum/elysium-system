# Validar perguntas por microfone sem repetir a saudação

O operador confirmou entrada na chamada, áudio ElevenLabs audível e perguntas
recebidas por voz. A falha relatada é ouvir repetidamente a primeira mensagem do
agente. Esta revisão precisa de deploy e audição humana para ser aceita; testes
sintéticos não confirmam o conteúdo ouvido na chamada.

## Diagnóstico e limites da evidência

O ponto de integração em `bot.ts` não passava `suppressFirstMessage`, apesar de o
adapter já suportar o override documentado. Isso permitia executar a primeira
mensagem publicada em cada sessão nova. Habilitar o override elimina essa origem
de saudação quando a conta permite First message override. Não demonstra, por si
só, que a pergunta foi reconhecida pelo ASR do ElevenAgents.

Uma sessão existente é indexada pelo Discord ID e reutilizada enquanto canal,
versão de consentimento e estado do turno forem compatíveis. A wake word não
recria sozinha a sessão. Nova sessão é necessária após revogação, saída,
interrupção de resposta reconhecida, expiração, erro/fechamento do transporte e recuperação de turno sem
conclusão. A V4 também pode retirar uma sessão sem conclusão quando há outra
pergunta esperando, texto recebido, áudio local drenado e nenhuma ferramenta
conhecida pendente. A sessão seguinte não herda automaticamente contexto remoto.
Repetir a saudação nessa recuperação era consequência possível da configuração
inicial permitida, não prova de que toda ativação criava uma conexão nova.

O detector de wake analisa somente uma cópia limitada aos primeiros quatro
segundos. Após ativação, o manager envia o turno PCM completo capturado para a
mesma sessão do usuário, incluindo a pergunta após “Jarvis”. A conversão é de
48 kHz estéreo para a taxa mono PCM negociada. O código envia frames de 20 ms com
pacing e 0,8 s de silêncio final; não converte a transcrição do detector em uma
pergunta escrita nem envia uma pergunta fixa.

O receiver encerra após 600 ms de silêncio e usa RMS mínimo de 0,008; o teto é
`JARVIS_MAX_AUDIO_SECONDS_PER_TURN` (12 s por padrão). Uma pausa longa entre
“Jarvis” e a pergunta pode separar capturas. Esses números são limites atuais,
não medições de acurácia do microfone. O turn-taking remoto continua no agente;
não houve ajuste especulativo de timeout ou mudança de protocolo para resolver
saudações.

Uma interrupção da saída inicial recebida enquanto a primeira fala está sendo
enviada não pode abortar esse upload. O manager agora aguarda reconhecimento e
preserva a fala inteira nesse caminho, como a separação entre entrada e saída do
[SDK oficial](https://github.com/elevenlabs/packages/blob/main/packages/client/src/VoiceConversation.ts).
Mensagens e áudio da saudação ficam em quarentena; os identificadores são usados
apenas em memória, sem supor sequência de chunks. Um ASR com ID já observado não
autoriza a pergunta seguinte. Sem identificadores, a correlação depende da sessão
autenticada e da fase de envio, sem inventar garantias adicionais.

## Preparar ElevenLabs e Render

1. No agente efetivamente publicado, confira português, voz autorizada, PCM e
   `text_only` desativado. Preserve prompt e tools existentes.
2. Em Security, permita **First message** override. O worker usa
   `JARVIS_SUPPRESS_FIRST_MESSAGE=true` por padrão e envia somente
   `conversation_config_override.agent.first_message: ""`. Não habilite System
   prompt ou Tools override para isso. Se a conta não permitir o ajuste, publique
   First message vazio e configure deliberadamente a variável como `false`.
   Uma recusa não deve ser contornada por tentativa automática sem supressão.
3. Inclua `user_transcript` em `conversation_config.conversation.client_events`,
   preservando `audio`, `agent_response`, `agent_response_complete`,
   `interruption`, `client_tool_call` e `client_error`. O evento de reconhecimento
   precisa conter uma fala final válida; não use áudio de saudação como evidência.
4. Revise os ajustes publicados de ASR/turn-taking. `user_transcript` comprova
   reconhecimento dentro da conversa; STT de wake e upload bem-sucedido são
   etapas anteriores. Alterar Take turn after silence ou turn eagerness exige
   medição própria; o silêncio final local não é uma confirmação de ASR.
5. Faça push do commit revisado e deploy manual no **Background Worker existente**
   do Jarvis: `rootDir: jarvis`, build `npm ci && npm run build`, start
   `npm run start`, uma instância. Preserve serviço Python, plano/região e
   variáveis privadas. Confira o SHA implantado e encerramento do processo antigo.
6. Configure `JARVIS_VOICE_INPUT=elevenlabs-stt` somente após revisar retenção e
   custos. Após restart, cada participante deve renovar
   `/jarvis consent audio:true`. Não habilite barge-in para este teste inicial.
7. Confirme `jarvis_ready` com `diagnostics_version: 5`.
   `first_message_override_requested=true` indica a política solicitada; não
   confirma que o provedor a aceitou. Uma recusa de iniciação deve aparecer como
   `AGENT_INITIATION_REJECTED`, sem fallback que reative a saudação.

Não cole credenciais, signed URLs, perguntas reais, transcrições ou áudio no
relatório. A configuração remota da conta não é modificada pelo commit.

## Testar na chamada real

Use fones, entre na mesma sala e execute `/jarvis join`. Comece com uma sessão
nova após reinício ou `/jarvis cancel`, mantendo o consentimento necessário.

1. Diga de forma contínua: **“Jarvis, quanto é dois mais dois?”**. Aguarde o fim
   natural da fala. Ouça uma resposta que resolva a pergunta (quatro), sem substituir
   a resposta pela saudação inicial. Som isolado ou apenas “como posso ajudar?” não
   aprova o teste.
2. Faça pelo menos duas perguntas consecutivas após a resposta, incluindo uma
   dentro do follow-up e outra com wake explícita. Confira sessão reutilizada
   quando possível e abertura nova somente pelos motivos documentados. Não
   confunda recuperação sem `agent_response_complete` com reinício desnecessário.
3. Repita após nova sessão, com outro participante consentido e alternância entre
   dois Discord IDs. Cada áudio deve responder ao solicitante correto; nenhuma
   resposta de uma sessão anterior deve aparecer no turno seguinte.
4. Revogue consentimento durante upload/playback e saia da call. O envio e a
   reprodução daquele participante devem parar, inclusive callbacks atrasados.
   Renove consentimento antes de continuar.
5. Se houver só wake, upload ou áudio automático, sem reconhecimento da pergunta,
   marque o caso como falha de reconhecimento/atribuição. Inspecione as etapas
   abaixo antes de alterar VAD, duração ou protocolo.

## Evidências técnicas sanitizadas

Correlacione as etapas pelo incidente local de oito hexadecimais. Não registre
Discord IDs, IDs de conversa remotos, áudio, texto ou hashes de conteúdo. Os
contadores são agregados; uma soma do processo não prova que os eventos pertencem
à mesma pergunta. O log por incidente permite verificar a sequência:

| Etapa | O que comprova | O que ainda não comprova |
| --- | --- | --- |
| `jarvis_voice_captured`, duração e bytes | Receiver entregou PCM consentido | Wake ou reconhecimento da pergunta |
| `jarvis_wake_detected`, wake/follow-up | Ativação local foi autorizada | ASR da conversa |
| Sessão aberta/reutilizada, `session_reused` e formatos | Transporte atribuído à entrada autenticada | Envio de todos os frames |
| `jarvis_agent_input_started` / `jarvis_agent_input_sent`, frames/bytes/silêncio | PCM foi encaminhado à sessão e silêncio final enviado | Reconhecimento remoto |
| `jarvis_agent_user_turn_recognized` após `user_transcript` válido | ElevenAgents reconheceu uma fala de usuário | Correção semântica da resposta |
| `jarvis_agent_response_observed`, áudio após reconhecimento | Geração seguiu o reconhecimento daquele turno | Audição real ou resposta correta |
| Playback/drain | Pacotes foram consumidos localmente | Conteúdo ouvido pelo participante |
| Confirmação humana na chamada | Pergunta respondeu quatro sem saudação repetida | Acurácia para toda fala/ambiente |

`agent_response` frequentemente chega depois que o áudio já começou; não é uma
barreira necessária para playback progressivo. `agent_response_complete` continua
um sinal explícito útil, mas sua ausência não bloqueia o início do áudio válido.
Também não se usa uma saudação anterior ao reconhecimento para encerrar ou
aprovar o turno de voz.

`jarvis_agent_initial_output_discarded` informa saída inicial descartada antes
de uma fala reconhecida. Confira `voice_turns_captured`, `voice_wake_activations`,
`agent_input_audio_chunks`, `agent_input_audio_bytes`, `agent_user_turns_recognized`,
`agent_responses_after_recognition`, `agent_initial_audio_discarded`,
`agent_initial_response_discarded` e `agent_user_turn_missing`. Wake e reconhecimento
conversacional têm contadores distintos; nenhum contém texto nem áudio.
`AGENT_USER_TURN_MISSING` significa que não houve reconhecimento final válido
após o upload: confira o evento publicado, ASR e VAD. Uma saudação recebida nesse
intervalo não renova a espera nem é contabilizada como resposta reconhecida.
`agent_input_interruptions` identifica interrupção da saída inicial que preservou
a entrada; a revogação e o cancelamento explícito continuam abortando ambos.
Se a conclusão chegar antes de terminar o upload, `agent_completion_during_input`
registra essa ordem. A reprodução continua progressiva, mas o fechamento local
espera o envio integral da captura e do silêncio final. Isso evita cortar a
pergunta por uma resposta precoce do provedor; não comprova que ele reconheceu
todas as palavras. A audição real continua necessária.
Se o WebSocket fechar antes de enviar a captura inteira, o código sanitizado
`AGENT_INPUT_INCOMPLETE` e `agent_input_incomplete` distinguem essa falha: o envio
para, o áudio válido já aceito pode drenar e o turno não é aprovado como concluído.

## Registro de aceitação

| Campo | Resultado desta revisão |
| --- | --- |
| Build / typecheck / lint | Passaram |
| Testes Node | 23 arquivos; 371 passaram e 1 gate real explicitamente skipped |
| Testes Python | 78 testes e 67 subtests passaram; Elysium sem alterações |
| SHA implantado no Render | Pendente |
| First message override / versão publicada verificados | Pendente |
| Pergunta nova reconhecida e resposta quatro ouvida | Pendente de chamada real |
| Perguntas consecutivas e duas pessoas | Pendente de chamada real |
| Revogação / saída sem áudio tardio | Pendente de chamada real |

Registre apenas data, SHA, incidentes e resultados técnicos/“ouvido sim ou não”.
Sem audição humana, a entrega é correção implementada e verificada localmente,
com aceitação de produção pendente.

Fontes oficiais consultadas em 21/10/2026: [Overrides](https://elevenlabs.io/docs/eleven-agents/customization/personalization/overrides),
[Client events](https://elevenlabs.io/docs/eleven-agents/customization/events/client-events),
[WebSocket API](https://elevenlabs.io/docs/eleven-agents/api-reference/eleven-agents/websocket)
e [Conversation flow](https://elevenlabs.io/docs/eleven-agents/customization/conversation-flow).
