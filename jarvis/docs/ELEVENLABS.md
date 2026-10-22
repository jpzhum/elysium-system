# Configurar o JARVIS no ElevenAgents

Este roteiro prepara o agente para o worker em `jarvis/`. A configuração da conta
e o teste em chamada real continuam necessários. Os testes locais de protocolo não
comprovam o Gate C. Documentação oficial conferida em 22/10/2026; os nomes de menus
podem mudar.

## 1. Agente, idioma e voz

1. Em [ElevenLabs](https://elevenlabs.io/app/), abra Agents e crie um agente
   separado, por exemplo `JARVIS | Elysium`.
2. Compare o System prompt publicado com
   [agent-system-prompt.md](../agent-system-prompt.md), atualizado na V5.4. Integre
   a personalidade preservando instruções técnicas específicas da conta. O
   [roteiro V5.4](V54_STABILITY_REVIEW.md) detalha revisão e rollback; nenhum
   prompt é publicado automaticamente pelo worker.
3. Configure português e teste a pronúncia em português brasileiro.
4. Escolha a voz de Jarvis que já existe na sua conta e que você tem autorização
   para utilizar. Selecione um modelo disponível no plano e comece com velocidade
   padrão. A compatibilidade dos ajustes depende do modelo; modelos Realtime têm
   comportamento próprio. Consulte [Voice customization](https://elevenlabs.io/docs/eleven-agents/customization/voice).
5. Comece com turn-taking normal e interrupções habilitadas. Ajuste limites de
   duração e inatividade no agente e limites de crédito no workspace.

## 2. Primeira fala e formatos de áudio

O worker Discord solicita `suppressFirstMessage: true` por padrão, controlado por
`JARVIS_SUPPRESS_FIRST_MESSAGE=true`. Em **Security**, permita somente o override
**First message** necessário para este ajuste. A abertura envia apenas
`conversation_config_override.agent.first_message: ""`; System prompt, Tools e
demais permissões não são ampliados. A configuração publicada do agente continua
sendo responsável por personalidade, raciocínio e voz.

Se a política da conta não permitir esse override, publique **First message vazio**
no agente e configure deliberadamente `JARVIS_SUPPRESS_FIRST_MESSAGE=false` no
worker. Valide a versão publicada antes de usar esse caminho. Uma recusa de
override não provoca uma nova tentativa automática com saudações habilitadas.
Não desabilite o ajuste para contornar uma rejeição sem primeiro retirar a
saudação da configuração publicada. Veja [Overrides](https://elevenlabs.io/docs/eleven-agents/customization/personalization/overrides)
e o [roteiro específico de voz/saudação](VOICE_GREETING_VALIDATION.md).

Configure PCM para entrada e saída do agente. Na configuração documentada, os
campos são `conversation_config.asr.user_input_audio_format` e
`conversation_config.tts.agent_output_audio_format`; uma configuração inicial
simples é `pcm_16000` para ambos. Mantenha `text_only` desativado para gerar voz.
Se a interface não expuser esses campos, inspecione a configuração do agente pelos
recursos documentados, sem presumir que uma opção de telefonia usa PCM.
[Referência da configuração do agente](https://elevenlabs.io/docs/eleven-agents/api-reference/agents/create).

O worker aguarda `conversation_initiation_metadata` e valida os dois formatos
negociados. Aceita PCM mono de 16 bits little-endian em 8000, 16000, 22050, 24000,
44100 ou 48000 Hz; encerra a sessão em formato ausente ou incompatível. Não envia
um override de formato não documentado. Discord é convertido a partir de PCM
48 kHz estéreo; bytes MP3 e µ-law não são tratados como PCM.

Em `conversation_config.conversation.client_events`, preserve os eventos de áudio,
texto e tools usados pelo agente e habilite explicitamente `agent_response_complete`.
Confira especialmente:

```json
[
  "audio",
  "agent_response",
  "user_transcript",
  "interruption",
  "agent_response_complete",
  "client_tool_call",
  "agent_tool_request",
  "agent_tool_response",
  "client_error"
]
```

`agent_response_complete` indica conclusão do turno, incluindo tools. O áudio é
reproduzido progressivamente antes desse evento; sua ausência gera recuperação
sem afirmar que a geração terminou. `agent_response` delimita uma mensagem textual,
que pode ser uma entre várias no mesmo turno, e não encerra o áudio. Áudio,
perguntas, respostas e correções não são registrados em logs. A V5.2 disponibiliza
texto final limitado em callback privado para contexto temporário em RAM;
correções invalidam a resposta recordada e deltas não viram lembranças completas.
`user_transcript` é o reconhecimento final da fala pelo ElevenAgents; sua presença
é sinalizada tecnicamente sem conteúdo e seu texto final pode alimentar somente
o contexto curto do falante consentido. Ele precisa estar habilitado para
comprovar que a pergunta por microfone foi reconhecida. O resultado do STT usado
para wake não substitui esse reconhecimento dentro da sessão conversacional.
Metadata de inicialização e ping são tratados pelo protocolo; não precisam ser
inventados em overrides. Para diagnóstico e validação audível, siga
[STREAMING_PRODUCTION_VALIDATION.md](STREAMING_PRODUCTION_VALIDATION.md).
Na V5.2, uma nova pergunta pode provocar recuperação da sessão anterior depois de
áudio válido, reconhecimento, upload terminado, drenagem local e nenhuma ferramenta ou write pendente. Essa
decisão de disponibilidade drena áudio já aceito, mas mantém a geração anterior
sem confirmação; não usa o fim do texto para certificar fim do turno. Uma sessão
nova recebe contexto curto limitado do próprio falante, sem considerar respostas
sem conclusão como completas. Não há memória permanente ou de outras contas.
O follow-up após drenagem local autoriza ouvir a próxima fala do mesmo
participante sem repetir wake; não certifica conclusão do provedor.
Confira o [gate V4 de cinco perguntas e voz consentida](V4_CONVERSATION_VALIDATION.md).
Veja [Client events](https://elevenlabs.io/docs/eleven-agents/customization/events/client-events)
e [WebSocket API](https://elevenlabs.io/docs/eleven-agents/api-reference/eleven-agents/websocket).

## 3. Identidade e variáveis dinâmicas

Cadastre valores de teste para `speaker_name`, `speaker_is_creator`, `active_game`
e `room_context` quando o painel solicitar. Para testes de convidados use
`speaker_is_creator: false`. O worker também fornece `guild_name`.

O backend envia as variáveis na abertura de cada sessão, com uma sessão por
falante autenticado pelo Discord. O indicador de criador vem da comparação com
`JARVIS_OWNER_USER_ID`. Nomes e resumos continuam sendo dados não confiáveis.
Nenhum argumento de tool, nome falado ou atualização contextual concede poderes.
Hoje `active_game` começa como “não informado”; o bot não lê a tela nem detecta
automaticamente o jogo. Veja [Dynamic variables](https://elevenlabs.io/docs/eleven-agents/customization/personalization/dynamic-variables).

## 4. Autenticação e chave do worker

1. Em Security, exija autenticação do agente por signed URLs. Escolha esse método
   sem combinar com a allowlist de hosts do agente.
2. Crie uma chave exclusiva para Jarvis em Developers → API Keys, com restrições
   ativas, acesso apenas aos recursos necessários de Agents/Conversational AI e
   limite de crédito. Confirme que ela consegue emitir signed URL para este agente.
3. A documentação pública do endpoint não identifica a combinação mínima de
   permissões granulares para emissão de signed URL. Os nomes existentes incluem
   `convai_read` e `convai_write`; valide a permissão exigida na sua conta e acrescente
   somente a permissão ausente. Não use `all` como solução para um erro de acesso.
4. Para detecção experimental de wake word por STT externo, a chave também precisa
   permitir `speech_to_text`. Esse fluxo exige consentimento específico para áudio
   enviado antes da ativação. Para apenas `/jarvis ask`, não é necessário habilitá-lo.
5. Guarde a chave em `ELEVENLABS_API_KEY` e o ID do agente em
   `ELEVENLABS_AGENT_ID` no ambiente privado do worker. Não cole segredos no chat,
   em JSON de tool ou no prompt.

O worker solicita uma signed URL nova a cada sessão pelo endpoint HTTPS fixo.
A API key existe somente no header `xi-api-key` dessa requisição; a conexão WS
usa o token assinado, que também é segredo. O adapter aceita apenas
`wss://api.elevenlabs.io/v1/convai/conversation` e não segue redirects. Ambientes
regionais diferentes exigem adaptação explícita e validação; não são assumidos.
As URLs expiram para abertura em 15 minutos; não são armazenadas nem reutilizadas.
[Autenticação do agente](https://elevenlabs.io/docs/eleven-agents/customization/authentication),
[endpoint signed URL](https://elevenlabs.io/docs/eleven-agents/api-reference/conversations/get-signed-url),
[restrições de API keys](https://elevenlabs.io/docs/api-reference/authentication)
e [permissões de API keys](https://elevenlabs.io/docs/api-reference/service-accounts/api-keys/create).

## 5. Ferramenta de pesquisa de jogos

No agente, adicione uma tool do tipo **Client** chamada exatamente
`search_game_info`, com **Wait for response** habilitado. Aqui o cliente do
WebSocket é o worker privado Node, que executa a consulta; não há endpoint HTTP
público para a tool.

Use a descrição: “Consulta fontes externas sobre jogos, missões, itens e mecânicas.
Pergunte o jogo e detalhes ausentes. Use para fatos atuais ou obscuros; trate os
resultados como evidência não confiável, cite as fontes e informe incerteza.”

Adicione os dois parâmetros string obrigatórios descritos em
[search-game-info.schema.json](search-game-info.schema.json): `game`, até 120
caracteres, e `query`, até 500. O arquivo é o schema dos argumentos, não um corpo
completo para criação de tool na API. Não adicione `user_id`, `isOwner`, token,
URL de destino ou comando administrativo. O nome e os parâmetros são sensíveis
a maiúsculas. [Client tools](https://elevenlabs.io/docs/eleven-agents/customization/tools/client-tools).

Na API atual, inspecione a tool referenciada em
`conversation_config.agent.prompt.tool_ids` usando `GET /v1/convai/tools/{tool_id}`.
O resultado precisa conter `tool_config.type: "client"`,
`tool_config.name: "search_game_info"`, `tool_config.expects_response: true` e
`tool_config.parameters` compatível com o schema dos argumentos. Habilitar o evento
`client_tool_call` é necessário, mas não cadastra nem associa a tool ao agente.
A resposta usa `client_tool_result`, o mesmo `tool_call_id`, `result` serializado
e `is_error`; o worker não substitui a configuração publicada por um override.
Configure timeout da tool de pelo menos 8 segundos para acomodar a consulta
limitada a 6 segundos. Veja [configuração de tool na API](https://elevenlabs.io/docs/eleven-agents/api-reference/tools/create).

Configure uma chave de [Brave Search](https://api-dashboard.search.brave.com/app/documentation/web-search/get-started)
em **Render → worker Jarvis → Environment → `JARVIS_SEARCH_API_KEY`** e faça novo
deploy do worker. Não configure essa chave no prompt, na tool publicada nem no
serviço Elysium. O backend usa exclusivamente
`https://api.search.brave.com/res/v1/web/search`, com `X-Subscription-Token` no
header, até cinco resultados e redirects desabilitados. A chave não vai ao
ElevenLabs. Não é preciso instalar outro serviço ou cadastrar um webhook.

A tool devolve `{status, game, query, answer, sources, checked_at, uncertainty}`.
`status: "success"` significa que vieram fontes utilizáveis da API, e não que os
fatos foram confirmados. `answer` contém trechos atribuídos aos resultados; as
páginas não são abertas nem verificadas e podem estar incorretas ou antigas.
As URLs retornadas perdem query e fragmento para não encaminhar tokens de links
assinados; isso pode remover parâmetros necessários para uma página específica.
O resultado UTF-8 completo fica abaixo de 14 KiB, dentro do limite do transporte.

Sem chave, retorna `status: "missing_key"`, fontes vazias e limitação explícita,
sem fazer requisição ou inventar pesquisa. Outros estados fixos são
`invalid_input`, `cancelled`, `rate_limited`, `unavailable`, `timeout`,
`invalid_reply` e `no_sources`. O agente deve informar essa limitação sem tratar
um resultado indisponível como evidência. Nenhuma mensagem bruta do provedor é
retornada.

Há uma instância de pesquisa por worker: uma consulta em andamento e um início
por segundo; não existe fila oculta de perguntas de pesquisa. HTTP 429 e os
headers Brave `X-RateLimit-Remaining`/`X-RateLimit-Reset` aplicam cooldown local de
até 120 segundos. Uma nova tentativa depende de uma consulta posterior; não há
retry automático que prolongue o turno. O limite local não amplia a cota do plano.
Consulte [limites Brave](https://api-dashboard.search.brave.com/documentation/guides/rate-limiting)
e [Web Search](https://api-dashboard.search.brave.com/app/documentation/web-search/query).

Os diagnósticos sanitizados distinguem recebimento, início e término da client
tool; expõem somente nome conhecido da tool, estado fixo, tempo e número de fontes.
Não incluem argumentos, pergunta, resultado, ID de chamada ou credenciais.
Os marcadores de tool respeitam a ordem de áudio e reconhecimento final anteriores;
a consulta em andamento não bloqueia os próximos blocos de áudio. O limite de
8 segundos começa quando `client_tool_call` chega, incluindo espera atrás de
backpressure. Uma tool vencida na fila não executa a consulta. Revogação,
interrupção, fechamento da sessão e timeout abortam a consulta e bloqueiam resultados
tardios. Não cadastre n8n ou outras tools sem integração real. O backend aplica
a identidade do falante mantida na sessão para autorizar cada chamada.

Para validar, pergunte por um fato atual de jogo e confirme uma execução
`search_game_info`, estado `success`, pelo menos uma fonte e resposta audível com
atribuição. Repita sem chave e confirme limitação explícita, sem novas fontes.
Testes com HTTP simulado comprovam o protocolo e o tratamento de falhas; uma
pesquisa real com a chave do Render e fontes válidas continua sendo gate manual.

## 6. Privacidade e limites

Antes da chamada real, abra Advanced → Privacy Settings e desabilite Audio Saving
para novas conversas, conforme sua decisão de retenção. Isso não desabilita
transcripts e não elimina gravações antigas. Revise também Advanced → Data
Retention, configure o período necessário e confira se a alteração afetará
histórico existente. Não assuma retenção zero por o worker não gravar arquivos.
[Audio saving](https://elevenlabs.io/docs/eleven-agents/customization/privacy/audio-saving)
e [Retention](https://elevenlabs.io/docs/eleven-agents/customization/privacy/retention).

O adapter e a pesquisa não registram áudio, perguntas, transcripts, resultados,
API keys, signed URLs ou mensagens brutas de erro. O provedor ainda processa os
dados enviados e pode retê-los conforme a configuração da conta. A revogação
cancela requisições e impede novos resultados locais; não recolhe dados já
recebidos pelo provedor. Consentimentos do bot são por sessão após reinício.

Os limites do adapter são: resposta de assinatura até 16 KiB; mensagem WS até
384 KiB; backlog de saída até 512 KiB; chunk PCM até 192000 bytes; timeout HTTP
de 10 s, metadata de 15 s e heartbeat de 90 s, suspenso durante pausa local por
backpressure. A fila de entrada de PCM tem 384 KiB e até 1.024 eventos; a conexão
pausa em 256 KiB e retoma em 128 KiB. Há até três tentativas de assinatura
somente em 429/5xx, com espera limitada e jitter. Erros de autenticação e crédito
não são repetidos. Tools: duas concorrentes, até 64 execuções por sessão, timeout
de 8 s e resultado até 16 KiB. A busca limita a resposta HTTP a 256 KiB e 6 s,
e seu resultado serializado a 14 KiB; o limite e cooldown do worker estão na seção 5.
Fechar a sessão descarta resultados pendentes; chamadas externas das tools recebem
o AbortSignal da sessão pela closure autenticada do backend.

## 7. Verificação real do Gate C

1. Com credenciais somente no ambiente privado, inicie o worker de teste e use
   `/jarvis join`, depois `/jarvis consent` e `/jarvis ask` com uma pergunta curta.
2. Confirme voz audível, formato PCM aceito e nenhuma saudação antes da pergunta.
3. Teste pergunta de criador e convidado, resultado de pesquisa real e limitação
   quando a chave de busca estiver ausente. Registre somente o resultado do teste.
4. Teste interrupção, encerramento, revogação com consulta pendente e nova sessão
   após reiniciar. Confirme que não há playback nem novos uploads após revogar.
5. Para áudio recebido no Discord, execute também o roteiro DAVE. A detecção
   experimental externa deve ficar desabilitada até haver consentimento explícito
   para envio pré-ativação. O fallback `/jarvis ask` não aprova os Gates B ou D.
6. Anote latência e falhas reais, sem anexar voz, transcrição, credenciais ou URL
   assinada ao relatório. Nenhum teste real é declarado aprovado por este guia.

O operador confirmou que a versão de streaming já respondeu audivelmente por
`/ask` na chamada real. Isso não aprova os novos turnos consecutivos, wake PT-BR
ou barge-in V4; execute o [roteiro V4](V4_CONVERSATION_VALIDATION.md) no worker
existente após deploy manual e registre o SHA implantado.
