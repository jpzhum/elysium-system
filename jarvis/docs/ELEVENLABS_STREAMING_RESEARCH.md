# ElevenAgents: eventos e reprodução progressiva

Pesquisa realizada em 21/10/2026. A reprodução real no Discord ainda precisa ser
ouvida durante a validação de produção.

## Evidência e limites da investigação

O teste independente informado recebeu HTTP 200, metadata, uma mensagem textual,
30 eventos de áudio e pings durante 55 segundos, sem `agent_response_complete`.
O evento também estava habilitado no agente publicado. No incidente `BABA0C1C`,
o Jarvis recebeu 79.360 bytes e aguardou 45 segundos sem reproduzi-los.

Isso comprova um bloqueio local: a versão anterior só liberava PCM ao receber
conclusão explícita. Não comprova a causa da ausência do evento no provedor.
Configuração ausente e parser incorreto não devem ser tratados como explicações
confirmadas para essas sessões.

## Contratos oficiais consultados

Na [documentação de Client Events](https://elevenlabs.io/docs/eleven-agents/customization/events/client-events),
`audio` transporta os blocos reproduzíveis. `agent_response` confirma uma mensagem
textual; em voz, seu áudio normalmente já começou a chegar. O texto não confirma
o encerramento do turno inteiro. `agent_response_complete` confirma o fim do turno,
incluindo ferramentas pendentes, e exige habilitação. `interruption` invalida a
resposta em andamento. `response_id` identifica uma mensagem; várias mensagens
podem pertencer ao mesmo turno.

A [referência WebSocket](https://elevenlabs.io/docs/eleven-agents/api-reference/eleven-agents/websocket)
documenta `agent_tool_request`, `agent_tool_response` e `mcp_tool_call`, além de
`client_tool_call`. MCP pode ficar em `loading` ou `awaiting_approval`. Ferramentas
pendentes são um motivo possível para o turno continuar aberto; os contadores
atuais não demonstram que isso aconteceu no incidente. O tipo de entrada
`user_message` não equivale a iniciar uma sessão `text_only`: não se deve mudar
o modo da sessão ou o payload de inicialização para tentar produzir conclusão.

## Conferência do SDK oficial

Foi inspecionado o pacote publicado [`@elevenlabs/client` 1.30.0](https://www.npmjs.com/package/@elevenlabs/client/v/1.30.0)
com `npm view` e `npm pack`, somente em diretório temporário. Seu `shasum` é
`6b043152c49e02e9849db1cb95fd02a08dc031f9`; ele referencia `@elevenlabs/types`
0.25.0. Nenhuma dependência do projeto foi alterada por essa pesquisa.

Os arquivos ESM publicados mostram:

- `utils/WebSocketConnection.js`, `handleMessage`: cada evento `audio` é
  encaminhado à saída, sem aguardar conclusão.
- `VoiceConversation.js`, `handleAudio`: o SDK aceita `event_id` igual ao limite
  de interrupção e rejeita somente os anteriores a esse limite. Portanto,
  `event_id` não deve ser tratado como número exclusivo de cada bloco.
- `BaseConversation.js`, `handleInterruption`: o limite vem de
  `interruption_event.event_id`.
- `BaseConversation.js`, `onMessage`, e `utils/events.d.ts`: essa versão nem
  contém tratamento de `agent_response_complete`. Isso demonstra que o playback
  oficial não depende desse evento; não demonstra uma falha do servidor.
- `@elevenlabs/types` 0.25.0, `generated/types/asyncapi-types.d.ts`: áudio contém
  `event_id`; `response_id` é opcional em mensagens textuais e não consta no
  esquema de áudio dessa versão. O adaptador preserva esse identificador quando
  oferecido, sem fabricar correspondências entre mensagens e áudio.

O código-fonte oficial correspondente fica no
[repositório ElevenLabs packages](https://github.com/elevenlabs/packages/tree/main/packages/client).
Os detalhes acima correspondem ao tarball versionado, pois a branch principal
pode mudar.

## Transporte e limites implementados

O adaptador entrega PCM progressivamente e aguarda a aceitação de cada bloco pela
fila limitada de playback. Preserva a ordem recebida pelo WebSocket e aceita
blocos repetindo `event_id`. Não reordena pacotes com base em um contador que o
protocolo não garante ser exclusivo.

PCM pendente, incluindo a escrita em andamento, fica limitado a 384 KiB, com no
máximo 1.024 eventos aguardando entrega. O WebSocket tem seu próprio limite de
384 KiB por mensagem. A conexão é pausada a partir de 256 KiB e retomada ao cair
para 128 KiB. Exceder o limite mesmo após a pausa encerra a sessão com código
sanitizado. Pausar o transporte também segura os frames seguintes; pings já
recebidos são respondidos imediatamente, fora da fila de áudio. Ferramentas,
interrupções e erros também são tratados fora dessa fila.
O heartbeat fica suspenso durante uma pausa local e sua janela reinicia ao
retomar a leitura; os prazos absolutos de sessão e playback continuam valendo.

Conclusão explícita entra atrás dos blocos recebidos anteriormente. Sua entrega
confirma que esses blocos foram aceitos pela fila de playback; a conclusão da
reprodução depende de essa outra fila ser esvaziada. Uma Promise do callback de
conclusão não bloqueia novas mensagens de protocolo.

No fechamento remoto, na falha de transporte e na recuperação local com
`close({ drainAudio: true })`, o transporte para de aceitar mensagens e os blocos
válidos já recebidos são entregues antes de `onClose`. Nenhum desses caminhos
fabrica um evento de conclusão. Cancelamento, revogação e fechamento local comum
descartam imediatamente a fila; uma revogação também cancela um drain pendente.
Erros de protocolo e de callback cancelam o fluxo com códigos fixos.

## Investigação de produção ainda necessária

Comparar uma entrada por texto com uma entrada de voz, usando o mesmo agente
publicado, e registrar somente tipos/quantidades de eventos, bytes, duração e
quantidade de ferramentas pendentes. Verificar se pedidos de ferramentas recebem
resultado e se existem aprovações MCP pendentes. Relacionar a versão publicada
informada pelo operador ao teste, sem registrar perguntas, resultados, áudio,
transcrições, chaves ou URLs assinadas.

Se o turno continuar aberto sem ferramenta pendente, encaminhar ao suporte do
provedor a versão do agente, horário e contadores sanitizados. Silêncio, término
do texto ou esvaziamento de playback não substituem confirmação de geração.
