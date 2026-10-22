# Verificar os incidentes do Jarvis no Render

## O que está comprovado

O incidente `07090582` registrou apenas `jarvis_command_failed` em `/jarvis join`.
Esse registro antigo não contém a etapa ou a exceção; não é possível recuperar a
causa apenas pelo ID. A revisão acrescenta diagnóstico para a próxima tentativa.

Posteriormente, um teste independente no Render recebeu HTTP 200, metadata,
uma mensagem textual, 30 eventos `audio` e 32 `ping`, mas nenhuma conclusão em
55 segundos. A conclusão estava habilitada na versão publicada
`agtvrsn_0201m5ge5vdfe148necsryg6a6wc`. O incidente `BABA0C1C` recebeu 79.360
bytes, mas o Jarvis os reteve até falhar em 45 segundos. Há áudio disponível;
o bloqueio local estava na dependência exclusiva do evento de conclusão.
A causa de o provedor não emitir esse evento continua sem comprovação.

Defeito comprovado no código anterior: timeout removia a sessão, abortava o WS e
o callback desse cancelamento incrementava `agent_errors` incondicionalmente.
Assim, o timeout podia gerar um erro secundário sem outra falha do provedor.
O novo teste reproduz essa sequência com adapter e manager integrados.

## Contrato ElevenLabs conferido

O [Client Events oficial](https://elevenlabs.io/docs/eleven-agents/customization/events/client-events)
documenta `agent_response_complete` com
`agent_response_complete_event.event_id` numérico e exige habilitação explícita
no agente. O handler existente já usava esse formato; ele foi preservado.
O evento sinaliza conclusão inclusive de tools. `agent_response` contém texto e
não é prova de término do áudio. `agent_chat_response_part.stop` encerra texto.

O worker não inventa campos de inicialização para habilitar eventos. Revise no
agente publicado `conversation_config.conversation.client_events`, mantendo
`audio`, `agent_response`, `interruption` e `agent_response_complete`, além dos
eventos necessários às tools configuradas. Inicialização e ping têm tratamento
próprio; não copie um dump de eventos para overrides. Veja também a
[referência WebSocket](https://elevenlabs.io/docs/eleven-agents/api-reference/eleven-agents/websocket).

Áudio válido segue progressivamente para Opus/Discord, com buffers limitados e
backpressure. O SDK oficial também inicia playback sem esperar conclusão.
`agent_response_complete` confirma a geração do turno; o fim do recebimento e o
esvaziamento local da reprodução são estados separados. Nenhum silêncio ou
timeout confirma geração completa. Após 45 s sem progresso e sem ferramenta
pendente, a recuperação fecha o transporte, drena os blocos válidos recebidos e
encerra o resultado como **não confirmado**, sem follow-up. Ferramentas pendentes
esperam os limites absolutos; expiração, revogação e desconexão cancelam a reprodução.
Veja a [pesquisa oficial e do SDK](ELEVENLABS_STREAMING_RESEARCH.md) e o
[roteiro completo de validação](STREAMING_PRODUCTION_VALIDATION.md).

## Preparar e implantar a revisão

1. Localmente, em `jarvis/`, execute `npm ci`, `npm run build`, `npm run typecheck`,
   `npm run lint` e `npm test`. Preserve dependências opcionais nativas; não use
   `--omit=optional`. Mantenha as versões do lockfile.
2. Envie o commit da correção à branch vinculada ao Render, por exemplo
   `git push origin main` se esse for o fluxo usado pelo proprietário.
3. No serviço **Background Worker jarvis-voice existente**, confira Root Directory
   `jarvis`, build `npm ci && npm run build`, start `npm run start` e Node 24.19.0.
   Não altere o serviço Python Elysium nem crie outro worker para esta correção.
4. Faça o deploy manual da revisão. O Blueprint mantém auto-deploy desligado.
   Aguarde o processo antigo encerrar antes da tentativa de voz; mantenha uma
   instância. Não execute outra cópia local com o mesmo token/guild.
5. Use `JARVIS_LOG_LEVEL=info` para acompanhar as etapas. Falhas também são
   registradas em nível `error`, com o snapshot relevante mesmo se info for filtrado.
6. Confirme `jarvis_ready` com `diagnostics_version: 3` nos logs do processo novo.
   Esse marcador confirma a instrumentação, não conexão de voz ou resposta audível.

Não há variável nova obrigatória. Credenciais continuam exclusivamente no
Environment privado. Esta revisão não realizou deploy, mudou a conta ElevenLabs
ou fez chamada Discord/ElevenLabs real.

## Nova tentativa de `/jarvis join`

O criador entra em uma sala regular e usa `/jarvis join`. A mensagem de falha
inclui um novo ID de oito hexadecimais; filtre por esse `incident` nos logs.
Não espere que a tentativa nova reutilize `07090582`.

As linhas contêm `stage`, `category`, `code`, `duration_ms` e, na falha de join,
`stage_duration_ms`. Duração é medida localmente, não uma estimativa de rede.

| Etapa | O que verificar |
| --- | --- |
| `authorize` | ID do criador configurado; nenhum papel administrativo do Discord concede posse do Jarvis |
| `interaction_ack` | `INTERACTION_EXPIRED`/`INTERACTION_ACKNOWLEDGED`; falha no reconhecimento da interação |
| `channel_lookup` / `channel_restriction` | Presença na sala, tipo GuildVoice e restrição opcional de canal |
| `member_fetch` | Consulta REST do próprio bot e códigos de acesso do Discord |
| `permissions` | Booleans `permission_view`, `permission_connect`, `permission_speak` efetivos no canal |
| `channel_capacity` | `CHANNEL_FULL` e `permission_full`; libere vaga sem conceder novos privilégios |
| `runtime_probe` | Node/arquitetura, AES-GCM e criação/reset nativo DAVE sintético |
| `voice_connect` | Criação da conexão, adapter e falhas síncronas classificadas |
| `voice_ready_wait` | Estado de voz/rede, código de fechamento e prazo de 20 s |
| `playback_setup` / `receiver_setup` | Falha após Ready; a tentativa descarta recursos parciais e sai |
| `join_reply` | Conexão pronta, mas envio da resposta Discord falhou; não implica falha de negociação |

`network_status=2` significa UDP/IP discovery, não prova bloqueio pelo Render.
`WS_CLOSE_4017` identifica exigência de DAVE. A biblioteca e a criptografia foram
mantidas; não se deve contornar esse código desligando DAVE. Detalhes e referências
em [VOICE_NEGOTIATION_NOTES.md](VOICE_NEGOTIATION_NOTES.md).

## Validar uma resposta audível real

1. Com Jarvis conectado e o criador na sala, use `/jarvis tone` e confirme ouvir
   o tom. Se não ouvir, confira volume local do bot, mute/supressão do servidor,
   permissões Speak/Connect e a negociação. Não conclua que HTTP 200 prova áudio.
2. Registre os contadores atuais de `/jarvis status`; eles acumulam por processo.
3. Leia `/jarvis privacy`, use `/jarvis consent` e envie uma pergunta curta por
   `/jarvis ask`, por exemplo pedindo que diga “teste de áudio concluído”. Esse
   fallback não requer consentimento para captar voz nem valida wake word.
4. Aguarde a resposta e consulte `/jarvis status` novamente. Use as **diferenças**
   entre os contadores, não seus totais históricos.
5. Antes da conclusão explícita, `audio_chunks_received`, `audio_bytes_received`,
   `audio_chunks_played`, `audio_stream_started` e `playback_started` devem subir.
   Ao drenar a fila, `playback_completed` sobe e `audio_stream_buffer_bytes` volta
   a zero. `agent_response_complete_received` só sobe se a conclusão chegar;
   sua ausência pode terminar em `turn_completion_missing`, sem impedir áudio.
6. Confirme também ouvir a frase inteira. `playback_completed` significa que a
   reprodução local terminou sem rejeição; não mede o que uma pessoa ouviu.
7. Teste revogação durante espera/playback: não pode haver novo upload/reprodução
   após revogar. Repita com outro participante, respeitando seu próprio aceite.

| Observação nova | Interpretação verificável / próxima checagem |
| --- | --- |
| Áudio positivo e conclusão zero | Áudio deve começar; recuperação termina como não confirmada. Investigar entrega do evento, ferramentas e diferenças entre entrada por texto e voz |
| Completion recebido, `agent_responses_completed=0`, `AGENT_INVALID_EVENT` | Envelope chegou, mas não passou validação; o fluxo é cancelado sem confirmar geração |
| `text_received=true`, áudio zero, `AGENT_TEXT_WITHOUT_AUDIO` | Texto observado sem áudio; conferir modo `text_only=false`, voz/TTS e erros do agente no painel |
| Nenhum áudio/texto/conclusão, `AGENT_RESPONSE_TIMEOUT` | Nenhum output observado em 45 s; verificar geração/tools e configuração de eventos, sem presumir TTS |
| `AGENT_PREMATURE_CLOSE` ou `AGENT_TRANSPORT_ERROR` | Drena áudio válido já recebido; mantém resultado não confirmado e uma falha primária |
| `PLAYBACK_FAILED` / `playback_failed` | Falha na fila, codificação, recurso ou limite de reprodução Discord |
| `AGENT_AUTHENTICATION_FAILED`, `AGENT_CREDIT_LIMIT`, `AGENT_RATE_LIMITED` | Erro primário classificado do provedor; fechamento subsequente não duplica a contagem |

`agent_responses_completed` conta conclusões válidas do turno; o contador
`agent_response_complete_events_received` registra chegada do envelope antes da
validação. `agent_text_events_received` e `text_received` registram presença de
texto sem guardá-lo. Chunks válidos recebidos fora de um turno são descartados e
contabilizados em `audio_chunks_discarded`.

Timeout local incrementa `agent_response_timeouts` uma vez. Se houver áudio,
gera `jarvis_agent_turn_recovering`; sem áudio gera falha com snapshot.
O abort local não incrementa `agent_errors`.
`agent_errors` é reservado às falhas primárias de provider/protocolo ou fechamento
prematuro. O encerramento esperado depois de uma conclusão tem contagem separada.
Use `jarvis_agent_turn_failed` e seu `incident` para correlacionar a falha do turno.

Os logs não incluem áudio/base64, texto de pergunta/resposta, transcrições, IDs
Discord/conversação, URLs/endereços da negociação, credenciais ou mensagens brutas
de exceção. Não habilite debug bruto nem registre o objeto de configuração.

## Evidência desta revisão

O registro de checks desta revisão está em
[IMPLEMENTATION_STATUS.md](../IMPLEMENTATION_STATUS.md). Os testes incluem
adapter + manager integrados e codificação Opus real com PCM sintético.
Nenhum desses resultados comprova som audível no Render. A aceitação operacional
exige a execução humana acima e o registro somente dos contadores/códigos.
