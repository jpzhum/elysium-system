# Diagnóstico da negociação de voz

Esta instrumentação permite localizar falhas de `/jarvis join`; ela não comprova
que o incidente de produção `07090582` foi resolvido. O diagnóstico depende de
uma nova execução no Render e dos registros correlacionados por `incident`.

O código permanece em `@discordjs/voice` 0.19.2. DAVE continua habilitado pelo
padrão da biblioteca, sem opção de desativação ou fallback adicionado. O bot
continua entrando com `selfDeaf: false`. Os limites anteriores permanecem:
20 segundos para `Ready`, 25 segundos para recuperação, com 5 segundos iniciais
para sinalização espontânea antes de `rejoin()`.

## Leitura dos estados

`voice_status=signalling` indica espera pelos eventos de voz do gateway principal.
`voice_status=connecting` permite acompanhar a negociação pelo `network_status`:

| network_status | Estado público da biblioteca | O que ainda está sendo negociado |
| --- | --- | --- |
| 0 | OpeningWs | Abertura do WebSocket de voz |
| 1 | Identifying | Identificação/autorização no gateway de voz |
| 2 | UdpHandshaking | Descoberta de IP e conectividade UDP |
| 3 | SelectingProtocol | Seleção do protocolo de transporte |
| 4 | Ready | Transporte estabelecido |
| 5 | Resuming | Retomada da sessão de voz |
| 6 | Closed | Rede encerrada |

O estado isolado não demonstra a causa de um timeout. Por exemplo, ficar em 2
justifica investigar UDP/descoberta de IP no ambiente, mas não prova bloqueio de
rede do Render. `voice_join_timeout` preserva os últimos estados conhecidos;
`jarvis_command_failed` os mantém mesmo quando eventos informativos forem
filtrados por `LOG_LEVEL`.

## DAVE e códigos de fechamento

O código WebSocket `4017` significa que o canal exige suporte ao protocolo
E2EE/DAVE. Ele gera `category=dave`, `code=WS_CLOSE_4017` sem ser transformado
em timeout. A biblioteca pode retornar a `signalling` para códigos diferentes
de `4014`, deixando o fechamento original fora de `VoiceConnection.state`.
Por isso são observados também `Networking.close` e o fechamento do WebSocket.

`dave_protocol_version` vem do wrapper público da biblioteca e `dave_ready` vem
somente do booleano público `dave.session.ready`, quando uma sessão existe.
Nenhuma sessão, chave, pacote, código de privacidade, lista de clientes ou payload
é serializado. A ausência de `dave_ready` significa ausência desse dado naquele
instante; `Ready` do transporte não substitui o teste real de áudio/DAVE descrito
em [DAVE.md](DAVE.md).

Erros assíncronos anteriores a `Ready` conservam sua classificação sanitizada,
como `ECONNRESET`, `NATIVE_BINDING_UNAVAILABLE` ou `DAVE_UNSUPPORTED_PROTOCOL`.
O cancelamento por `/jarvis leave` gera `JOIN_CANCELLED`, distinto de
`JOIN_TIMEOUT`. Listeners de estados, rede e WebSocket e os timers de espera são
removidos ao encerrar a conexão. Um único listener inerte, compartilhado e sem
referências ao comando, absorve erros tardios no EventEmitter já destruído.

O código não habilita nem registra `debug` da biblioteca: esses textos podem
conter dados de negociação. Nenhuma mensagem bruta de exceção é registrada.

## Verificação local sem Discord

Em `jarvis/`, execute:

```console
npx vitest run tests/voice-connection.test.ts tests/dave-smoke.test.ts
```

Os testes simulam timeout UDP, fechamento DAVE `4017`, falha de adapter,
dependência nativa indisponível, erro assíncrono, recuperação, cancelamento e
eventos tardios. Também verificam que tokens, URLs, áudio e chaves sintéticos
permanecem fora dos logs. Nenhum teste se conecta ao Discord.

Fontes oficiais: [códigos de fechamento do Discord](https://github.com/discord/discord-api-docs/blob/main/developers/topics/opcodes-and-status-codes.mdx),
[estados de rede](https://discord.js.org/docs/packages/voice/0.19.0/NetworkingStatusCode%3AEnum)
e [protocolo de voz e DAVE](https://github.com/discord/discord-api-docs/blob/main/developers/topics/voice-connections.mdx).
