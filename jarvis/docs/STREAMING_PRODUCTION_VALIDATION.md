# Streaming de voz: evidência e validação no Render

A aceitação operacional exige que uma pessoa ouça o Jarvis na chamada real do
Discord. Build, testes, HTTP 200, contadores positivos e conclusão local do player
não comprovam essa audição. Este roteiro prepara essa validação; não registra um
deploy nem um teste audível já realizado pelo agente. Posteriormente, no pedido
V4, o operador confirmou saída progressiva audível em produção. O gate de cinco
perguntas consecutivas e voz consentida da revisão V4 continua pendente; siga
[V4_CONVERSATION_VALIDATION.md](V4_CONVERSATION_VALIDATION.md).

## Evidência que motivou a mudança

O teste independente informado pelo operador, executado diretamente no Render
sem o código do Jarvis, observou:

| Sinal | Resultado informado |
| --- | --- |
| Autenticação HTTP | 200 |
| WebSocket | conectado |
| `conversation_initiation_metadata` | 1 |
| `agent_response` | 1 |
| `audio` | 30 |
| `ping` | 32 |
| `agent_response_complete` | 0 |
| Encerramento do teste | timeout após 55 s |

A configuração consultada na API incluía `agent_response_complete` habilitado;
a versão retornada foi `agtvrsn_0201m5ge5vdfe148necsryg6a6wc`. No incidente do
Jarvis `BABA0C1C`, chegaram **79.360 bytes de áudio**, mas o turno terminou após
45 s com `AGENT_COMPLETION_MISSING` e nenhum som.

A causa demonstrável no código anterior era o bloqueio do playback: `audio()`
acumulava PCM e somente `agent_response_complete` liberava `flush()`. Ao expirar
o prazo, a remoção da sessão apagava o áudio. A reprodução dependia, portanto, de
um evento ausente nas sessões observadas, apesar de haver áudio válido.

Essa evidência não determina por que o serviço deixou de entregar o evento.
Também não demonstra erro de parser: o teste independente não usava o parser do
Jarvis. A entrega do evento, a versão publicada do agente, ferramentas pendentes
e diferenças entre perguntas escritas e entrada de voz continuam verificações
do provedor. Não altere o protocolo para presumir uma causa não demonstrada.

## O que significa cada conclusão

Os [Client Events oficiais](https://elevenlabs.io/docs/eleven-agents/customization/events/client-events)
e a [referência WebSocket](https://elevenlabs.io/docs/eleven-agents/api-reference/eleven-agents/websocket)
descrevem sinais com papéis distintos:

| Sinal | Uso no fluxo |
| --- | --- |
| `agent_response` | Mensagem textual produzida pelo agente; não confirma que todo o áudio ou o turno terminou |
| `audio` | Bloco de áudio disponível para reprodução progressiva, no formato PCM negociado |
| `agent_response_complete` | Confirmação explícita de conclusão do turno, incluindo ferramentas pendentes |
| `interruption` | Interrupção da saída em curso; cancela o áudio e impede eventos antigos de retomarem a reprodução |
| Fila vazia no Discord | O áudio já aceito foi consumido; não confirma conclusão da geração |
| Timeout/fechamento do WebSocket | Fronteira de recuperação ou falha; não é confirmação de resposta integral |

O SDK oficial também inicia áudio por bloco, sem usar o evento de conclusão como
pré-condição. Consulte [ELEVENLABS_STREAMING_RESEARCH.md](ELEVENLABS_STREAMING_RESEARCH.md)
para fontes, versão do SDK inspecionada, identificadores dos eventos e limites
da investigação. O Jarvis mantém ElevenAgents como responsável por raciocínio,
personalidade e geração de voz; não introduz outro LLM ou TTS.

## Segurança e encerramento

Os blocos válidos são consumidos progressivamente em ordem. O encoder mantém a
continuidade entre blocos PCM e produz Opus de 20 ms para o Discord. O fluxo tem
limites de fila, memória e duração, além de backpressure; nenhuma resposta inteira
precisa ser carregada antes do primeiro pacote audível.

O player admite até quatro streams, limita cada resposta a 120 s de PCM e
mantém até 384 KiB de PCM na sua fila por stream. O recurso tem prazo absoluto
de 180 s, incluindo espera e pausas. A recepção WebSocket tem um limite próprio
de 384 KiB, pausa o transporte sob pressão e mantém também um limite de eventos.
Esses tetos encerram trabalho excedente; não transformam o encerramento em
conclusão confirmada. O limite de memória do player não deve ser confundido com
o consumo total do processo, que inclui buffers limitados do transporte e codec.

Geração, ingresso de áudio, drenagem do player e conclusão do turno são estados
distintos. O sinal explícito fecha a geração quando chega. Na sua ausência, a
política de recuperação após **45 s sem progresso**, desde que não haja
ferramenta sinalizada como pendente, encerra o ingresso e a sessão do provedor, permite drenar áudio
válido já aceito e registra `turn_completion_missing`. Áudio, resposta textual e
sinais de ferramentas são progresso; pings de transporte não renovam esse prazo.
O prazo de inatividade também fica suspenso enquanto uma escrita aguarda espaço
na fila de playback: backpressure local não é silêncio do provedor. Os limites
absolutos de reprodução e sessão continuam valendo durante essa espera.
O fechamento conserva a ordem dos blocos aceitos antes do corte e sela o stream
depois dessa entrega; o player termina de esvaziar sua própria fila.
Esse encerramento fica **sem confirmação de conclusão**. Silêncio e prazo
decorrido nunca são registrados como prova de que o agente terminou de gerar.
Uma nova pergunta após recuperação abre uma sessão nova, impedindo que saída
tardia do turno anterior seja atribuída ao próximo.

Na V4, se uma pergunta está aguardando, mensagem textual recebida, drenagem
local e ausência de ferramenta conhecida pendente permitem retirar a sessão
anterior sem esperar 45 s. O transporte corta entrada e drena blocos aceitos
antes da fronteira; só depois inicia a próxima pergunta. O resultado fica sem
confirmação, inclusive se outra mensagem ou ferramenta remota ainda pudesse ser
gerada. Essa política não preserva automaticamente o contexto remoto da sessão
encerrada nem transforma silêncio em geração concluída.

Fechamento remoto ou erro de rede também encerram a sessão e permitem drenar o
áudio válido aceito antes dessa fronteira. Sem um sinal explícito recebido, a
geração permanece sem confirmação. São falhas primárias
classificadas; o fechamento local de limpeza não deve duplicá-las. Isso difere
de revogação, saída da sala ou expiração, que cancelam imediatamente o player.
Na V4, a drenagem local pode abrir uma janela de follow-up apenas para ouvir a
próxima fala do mesmo participante sem repetir wake. Essa autorização não
confirma geração integral. Reutilização de contexto depende da sessão válida;
retirar uma sessão sem conclusão pode abrir outra sem o contexto anterior.

Ferramentas pendentes não autorizam declarar o turno concluído e suspendem a
recuperação por ociosidade. O limite absoluto da sessão continua aplicável:
`JARVIS_MAX_SESSION_SECONDS`, **300 s por padrão**. A expiração cancela o áudio
com `AGENT_SESSION_EXPIRED`, inclusive se houver ferramenta pendente. Ela não
declara a geração concluída. Os prazos próprios das client tools continuam
limitados. Ferramentas do provedor que não enviem sinal ao cliente não podem ser
inferidas do silêncio; uma recuperação permanece sem confirmação nesse caso.
Múltiplas mensagens de um agente podem fazer parte do mesmo turno; o término de
uma mensagem textual não fecha o stream por conta própria.

Cada stream pertence ao participante e ao consentimento que o originaram.
Participantes aguardam sua vez; o proprietário ganha prioridade entre respostas
em espera e não corta uma resposta ativa. Revogação, troca de consentimento,
saída da sala, cancelamento, expiração ou desconexão cancelam imediatamente a
saída correspondente e apagam buffers. O áudio já enviado ao Discord não pode
ser recolhido. Nenhum pacote novo deve ser preparado depois da invalidação.

Os identificadores recebidos do protocolo são usados somente conforme sua
semântica documentada. Um `event_id` repetido não é, por si só, prova de chunk
duplicado: blocos da mesma resposta podem compartilhar um identificador.
Não se inventa um número sequencial de chunk ausente no protocolo.
Quando o provedor oferece `response_id`, mensagens de turnos já concluídos não
podem alimentar o novo stream. O identificador não é inventado quando ausente;
a ordenação do WebSocket e as fronteiras de sessão/interrupção continuam sendo
as referências nesses casos. Os históricos em memória também têm limite.

## Preparar o deploy existente

1. Na pasta `jarvis`, execute `npm ci`, `npm run build`, `npm run typecheck`,
   `npm run lint` e `npm test`. Use `npm.cmd` no PowerShell se necessário.
   Preserve o lockfile e dependências opcionais; não use `--omit=optional`.
2. Envie o commit revisado à branch conectada ao Render. Registre o SHA que o
   dashboard efetivamente implantou.
3. No **Background Worker `jarvis-voice` existente**, mantenha Root Directory
   `jarvis`, build `npm ci && npm run build`, start `npm run start`, Node 24.19.0
   e uma instância. Não sincronize o Blueprint para criar outro serviço.
4. Faça deploy manual dessa revisão e confirme que o processo anterior encerrou.
   Não rode outra instância com o mesmo bot/guild durante o teste.
5. Mantenha credenciais no Environment privado e `JARVIS_LOG_LEVEL=info` para a
   validação. Não imprima configurações nem ative dumps brutos de WebSocket.
6. Confirme `jarvis_ready` com `diagnostics_version: 4`. Esse sinal confirma inicialização, não valida saída
   audível, entrada DAVE ou conclusão de resposta.

O serviço Elysium Python, seus intents, permissões e contratos persistentes
continuam separados. DAVE permanece habilitado no caminho Discord e não há
fallback de criptografia inseguro.

## Reproduzir e ouvir uma resposta

1. O proprietário entra na sala regular configurada e executa `/jarvis join`.
   Confira as permissões efetivas View Channel, Connect e Speak e o volume local
   do bot; não acrescente Administrador ou intents privilegiados.
2. Execute `/jarvis tone` e confirme ouvir o tom. Se ele não for audível, resolva
   primeiro a saída Discord; sucesso HTTP do ElevenLabs não a comprova.
3. Capture os contadores de `/jarvis status` antes do teste. São acumulados por
   processo; compare diferenças, não totais históricos.
4. Leia `/jarvis privacy`, execute `/jarvis consent` e envie por `/jarvis ask`
   uma pergunta curta, por exemplo pedindo uma saudação. Esse caso valida entrada
   escrita e saída de voz sem exigir captura de voz ou wake word.
5. Confirme pessoalmente que a fala começa ao chegar áudio válido, enquanto o
   turno ainda pode estar aberto. Registre se a frase foi inteira e inteligível.
6. Observe os contadores abaixo. `agent_response_complete_received=0` deixa de
   impedir início de playback. Se continuar ausente, registre a recuperação e
   confira que uma nova pergunta funciona em sessão nova.
7. Repita com uma resposta mais longa. Confirme ordem, ausência de reinícios de
   chunks e memória limitada. Pausas do agente não podem ser registradas como
   confirmação de conclusão.
8. Se já houver aceite e configuração para entrada de voz, repita separadamente
   falando “Jarvis” e a pergunta. Registre se a ausência do evento difere entre
   entrada escrita e voz. Não habilite captura para quem não consentiu.

| Métrica | O que a diferença demonstra |
| --- | --- |
| `audio_stream_started` | O stream começou a alimentar o recurso de reprodução |
| `audio_chunks_received` / `audio_bytes_received` | PCM válido chegou ao Jarvis |
| `audio_chunks_played` | Blocos chegaram ao caminho de consumo do player; não mede audição humana |
| `audio_stream_buffer_bytes` | Bytes ainda retidos na fila; deve voltar a zero ao drenar/cancelar |
| `playback_started` | O player iniciou o recurso de voz |
| `playback_completed` | O recurso local terminou sem falha; não certifica que a resposta integral foi gerada ou ouvida |
| `agent_response_received` | Houve mensagem textual do agente, sem retenção do texto |
| `agent_response_complete_received` | Chegou confirmação explícita do provedor |
| `turn_completion_missing` | Recuperação, timeout ou perda de transporte sem confirmação explícita; não equivale a sucesso da geração |
| `playback_failed` | O caminho local de áudio falhou |

Texto sem áudio exige diagnóstico próprio: `agent_response_received > 0` com
`audio_chunks_received=0` não é falha de Opus. Confira formato de saída negociado,
modo de voz do agente e ferramentas/erros de geração no painel privado do
provedor. Falha primária de WebSocket, timeout e fechamento local subsequente
devem ser contados separadamente; o cancelamento da limpeza não cria uma segunda
falha de provedor.

## Matriz de aceitação real

| Caso | Resultado exigido |
| --- | --- |
| Áudio sem evento de conclusão | Fala inicia; saída aceita drena; ausência fica registrada, sem conclusão inventada |
| Evento explícito presente | Ingresso encerra; player drena; geração e playback têm confirmações distintas |
| Dois participantes consentidos | Respostas serializadas e nenhuma mistura de sessão; proprietário prioriza somente itens em espera |
| Revogação durante fala | Áudio daquele participante cessa imediatamente; fila e sessão são canceladas |
| Participante sai da sala | Nenhum áudio pendente dele é reproduzido |
| `/jarvis leave` ou saída efetiva do bot da sala | Streams, sessões e buffers encerram; entrar novamente exige novo aceite |
| Perda transitória da conexão de voz | Playback pendente cancela; após Ready, a fila aceita novas perguntas sem reutilizar áudio cancelado |
| Ferramenta demorada/pendente | Espera limitada, sem confundir silêncio com conclusão |
| Falha WebSocket | Código sanitizado e política de encerramento visíveis; sem loops ou erro secundário de limpeza |
| Resposta longa e pausas | Buffer limitado, ordem íntegra, sem cortar a fala por uma pausa curta |
| Nova pergunta após recuperação | Sessão nova; eventos antigos não retomam áudio |
| Pergunta aguardando após fala já consumida | Retirada da sessão sem conclusão, quando o gate V4 permite; sem aguardar indevidamente 45 s e sem alegar geração completa |

Não provoque deliberadamente uma queda de rede ou consumo prolongado em produção
para substituir testes isolados. Use a matriz real para operações autorizadas e
confirme os limites e falhas com os testes automatizados.

## Registro seguro do resultado

Preencha após o deploy e a audição, sem anexar conteúdo da conversa:

```text
Data/hora e fuso:
Commit implantado:
Versão do agente conferida no painel privado:
Entrada testada: escrita / voz consentida
Tom Discord ouvido: sim / não
Resposta ElevenAgents ouvida: sim / não
Início progressivo confirmado: sim / não
Fala inteira/inteligível: sim / não / sem confirmação do provedor
Diferenças dos contadores técnicos:
Conclusão explícita observada: sim / não
Recuperação sem conclusão observada: sim / não
Revogação e dois participantes aprovados: sim / não
Incidentes e códigos sanitizados:
Pendências:
```

Não copie perguntas, respostas, transcrições, gravações, áudio/base64, nomes ou
IDs de participantes, chaves, credenciais ou URLs assinadas para logs ou issues.
Use apenas incidentes de oito hexadecimais, categorias, códigos e contadores
sanitizados. Os resultados automatizados estão em
[IMPLEMENTATION_STATUS.md](../IMPLEMENTATION_STATUS.md); o gate de audição
V4 permanece pendente até uma pessoa executar a validação de cinco perguntas e
voz consentida. A audição da revisão anterior foi confirmada pelo operador no
pedido V4; não foi repetida pelo agente durante esta revisão.
