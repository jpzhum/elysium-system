# Configurar o JARVIS no ElevenAgents

Este roteiro prepara o agente para o worker em `jarvis/`. A configuração da conta
e o teste em chamada real continuam necessários. Os testes locais de protocolo não
comprovam o Gate C. Documentação oficial conferida em 21/10/2026; os nomes de menus
podem mudar.

## 1. Agente, idioma e voz

1. Em [ElevenLabs](https://elevenlabs.io/app/), abra Agents e crie um agente
   separado, por exemplo `JARVIS | Elysium`.
2. Copie integralmente [agent-system-prompt.md](../agent-system-prompt.md) para o
   campo System prompt. O arquivo contém o texto original da seção 6 do anexo.
3. Configure português e teste a pronúncia em português brasileiro.
4. Escolha a voz de Jarvis que já existe na sua conta e que você tem autorização
   para utilizar. Selecione um modelo disponível no plano e comece com velocidade
   padrão. A compatibilidade dos ajustes depende do modelo; modelos Realtime têm
   comportamento próprio. Consulte [Voice customization](https://elevenlabs.io/docs/eleven-agents/customization/voice).
5. Comece com turn-taking normal e interrupções habilitadas. Ajuste limites de
   duração e inatividade no agente e limites de crédito no workspace.

## 2. Primeira fala e formatos de áudio

Deixe **First message vazio** no agente usado pelo Discord. Esse é o caminho
usado pelo worker atual: ele não solicita override de primeira mensagem. Uma
saudação é apropriada apenas no agente de teste do painel; retire-a antes de usar
o mesmo agente no Discord.

O adapter oferece `suppressFirstMessage: true` como opção de implementação,
desativada por padrão. Ela envia apenas
`conversation_config_override.agent.first_message: ""` e exige que o override
First message esteja habilitado em Security. Não habilite override de System
prompt ou Tools para resolver uma saudação. Veja [Overrides](https://elevenlabs.io/docs/eleven-agents/customization/personalization/overrides).

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
  "interruption",
  "agent_response_complete",
  "client_tool_call",
  "client_error"
]
```

`agent_response_complete` indica conclusão do turno, incluindo tools. O áudio é
reproduzido progressivamente antes desse evento; sua ausência gera recuperação
sem afirmar que a geração terminou. `agent_response` delimita uma mensagem textual,
que pode ser uma entre várias no mesmo turno, e não encerra o áudio. Transcripts,
correções e texto recebidos não são registrados. O adapter sinaliza somente que
houve texto, sem guardar seu conteúdo, para detectar uma resposta sem áudio.
Metadata de inicialização e ping são tratados pelo protocolo; não precisam ser
inventados em overrides. Para diagnóstico e validação audível, siga
[STREAMING_PRODUCTION_VALIDATION.md](STREAMING_PRODUCTION_VALIDATION.md).
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

Configure uma chave de [Brave Search](https://api-dashboard.search.brave.com/app/documentation/web-search/get-started)
em `JARVIS_SEARCH_API_KEY` no ambiente privado. O backend usa o endpoint fixo de
Web Search e devolve `{game, query, answer, sources, checked_at, uncertainty}`.
`answer` contém trechos atribuídos aos resultados; as páginas não são abertas
nem verificadas e podem estar incorretas ou antigas. Sem chave, a tool retorna
limitação explícita e não faz requisição. A chave não é enviada ao ElevenLabs.

Não cadastre n8n ou outras tools sem integração real. O backend aceita somente
pesquisa de jogos e aplica a identidade do falante mantida na sessão.

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
de 8 s e resultado até 16 KiB. A busca limita a resposta HTTP a 256 KiB e 6 s.
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
