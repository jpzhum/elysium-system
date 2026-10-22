# JARVIS Voice

Bot Discord independente, em Node/TypeScript, com ElevenAgents como cérebro,
ASR e voz. Elysium continua no serviço Python. Implementação técnica local;
recepção DAVE, conversas reais e deploy ainda precisam ser validados. Consulte
[IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) antes de operar.

Para falhas de `/join`, timeout de resposta ou ausência de som no Render, consulte
[o roteiro de diagnóstico e validação audível](docs/RENDER_INCIDENTS.md).

## Começar localmente

Requer Node >=22.12 (ambiente verificado: 24.19.0), npm e uma aplicação Discord
própria para Jarvis. Não reutilize o token do Elysium.

```console
cd jarvis
npm ci
npm run build
npm run typecheck
npm run lint
npm test
```

No Windows, use `npm.cmd` se o PowerShell bloquear `npm.ps1`; não é necessário
alterar a política de execução.

Copie `.env.example` para `jarvis/.env`, substitua os valores fictícios e preencha
segredos somente nesse arquivo privado ou no Environment do Render. `config.ts`
lê apenas esse `.env`, sem carregar o arquivo do Elysium. Obrigatórias:

| Variável | Valor |
| --- | --- |
| `JARVIS_DISCORD_TOKEN` | Token do novo bot Discord |
| `JARVIS_OWNER_USER_ID` | Seu Discord user ID; única identidade administrativa |
| `JARVIS_GUILD_ID` | ID do servidor permitido |
| `ELEVENLABS_AGENT_ID` | ID do agente privado configurado |
| `ELEVENLABS_API_KEY` | Chave dedicada, com limites na conta |

```console
npm start
```

O worker registra somente `/jarvis` no servidor configurado, não entra sozinho
em chamadas e não solicita intents privilegiados. Para testar DAVE antes de
habilitar ElevenLabs, basta preencher as três variáveis Discord e executar:

```console
npm run build
npm run smoke:dave
```

Nesse modo `/ask` não chama o provedor; o áudio consentido é medido apenas em
memória. Execute a matriz de [docs/DAVE.md](docs/DAVE.md). `/jarvis tone` reproduz
um tom sintético de 1 s para separar playback Discord da resposta ElevenLabs.

## Configurar Discord

1. Em [Developer Portal](https://discord.com/developers/applications), crie outra
   aplicação/bot Jarvis. Guarde o token no ambiente privado.
2. Em Installation/OAuth2, use Guild Install com `bot` e `applications.commands`.
   Conceda Visualizar canais, Conectar, Falar e Enviar mensagens. O bot não precisa
   de Administrador, Gerenciar cargos, Gerenciar canais ou intents privilegiados.
3. Instale no servidor; com Developer Mode copie seu user ID, guild ID e,
   opcionalmente, um voice channel ID para `JARVIS_DEFAULT_VOICE_CHANNEL_ID`.
   Essa variável limita `/join` a um canal; não ativa autojoin.
4. Entre numa sala de voz regular. O criador usa `/jarvis join`; o aviso público
   explica o serviço externo e o opt-in. Um canal cheio ou sem permissões impede
   a conexão. Salas Stage não são suportadas neste MVP.
5. Cada participante lê `/jarvis privacy`, aceita com `/jarvis consent` e usa
   `/jarvis ask texto:...`. A pergunta escrita vai ao ElevenAgents; a resposta
   será audível para a sala. Configure o agente conforme o guia a seguir.

| Comando | Acesso e efeito |
| --- | --- |
| `/jarvis join` | Criador: entra na própria sala |
| `/jarvis leave` | Criador: sai, cancela sessões e apaga consentimentos |
| `/jarvis tone` | Criador na sala: teste de saída com tom sintético |
| `/jarvis status` | Estado/contadores em resposta privada; sem transcrições |
| `/jarvis privacy` | Aviso de processamento e retenção |
| `/jarvis consent` | Participante na sala: aceita perguntas escritas |
| `/jarvis consent audio:true` | Aceite adicional para diagnóstico/voz experimental |
| `/jarvis revoke` | Qualquer usuário: cancela sua captura, sessão e resposta |
| `/jarvis ask texto:...` | Participante consentido na mesma sala: pergunta escrita |

Participantes não precisam de autorização individual para perguntas. Administração
é aplicada pelo backend comparando IDs; nomes e pedidos falados não concedem
poderes. O bot sai quando não restam humanos. Sair da sala, desconectar ou
reiniciar exige consentimento novo. Revogar também cancela trabalho pendente.

## ElevenLabs

Siga [docs/ELEVENLABS.md](docs/ELEVENLABS.md): agente privado, voz existente
autorizada, português, PCM negociado e evento `agent_response_complete` habilitado.
Copie [agent-system-prompt.md](agent-system-prompt.md) para System prompt e deixe
First message vazio. Não permita override de prompt/tools.

Signed URLs são obtidas no worker a cada sessão; API key e URLs nunca aparecem
nos logs. Cada falante tem sessão própria, aberta sob demanda. O bot não mistura
áudios nem mantém sessões permanentes para todos os usuários da sala. Não há
LLM/TTS próprio, integração n8n, leitura de tela ou memória durável.

Pesquisa opcional usa uma client tool de backend `search_game_info`, com o
[schema dos argumentos](docs/search-game-info.schema.json). Só configure
`JARVIS_SEARCH_API_KEY` se já houver uma chave Brave Search autorizada. Sem chave,
o retorno admite a limitação. Resultados são trechos com fontes e incerteza,
sem alegar que as páginas foram verificadas. Nenhuma API pública é criada.

## Ativação por voz experimental

`JARVIS_VOICE_INPUT=disabled` é o padrão seguro para `/ask`. Para experimentar
voz, passe primeiro pelo diagnóstico DAVE, revise retenção/custos da ElevenLabs e
configure `JARVIS_VOICE_INPUT=elevenlabs-stt`. Reinicie e peça novo aceite explícito
`/jarvis consent audio:true` de cada participante.

O receiver subscreve e decodifica apenas IDs que aceitaram áudio. Depois de VAD
local e fim de fala, o detector envia à ElevenLabs Scribe **até os primeiros
4 segundos de cada turno consentido, inclusive antes de dizer “Jarvis”**. Não é
um detector acústico local. Há limite global de verificações por minuto. A grafia
transcrita Jarvis/Járvis/Djárvis ativa uma sessão ElevenAgents para o falante;
o turno original segue em PCM mono negociado, em chunks com pacing e silêncio
final para VAD. Não há streaming permanente do canal inteiro.

O follow-up dura 18 s por padrão após a resposta, só para aquele falante. Enquanto
Jarvis reproduz áudio, a captura é suprimida para reduzir eco; barge-in de voz
durante playback não está implementado. Interrupções do provedor cancelam o upload
e o áudio daquele turno. A resposta completa é limitada e acumulada antes da
reprodução para serializar falantes; isso acrescenta latência. Dono ganha prioridade
na fila de respostas, sem interromper convidados no meio da fala.

O reconhecimento fonético real em PT-BR, falsos wakes, qualidade VAD, perda de
frames DAVE e latência ainda não foram medidos. Os testes de grafias usam texto
sintético. Não existe meta de 4 s ou custo/hora comprovado. O bug DAVE upstream
permanece risco até executar a matriz real; `/ask` não aprova voz de entrada.

## Limites, privacidade e parada

| Configuração | Padrão |
| --- | --- |
| `JARVIS_MAX_ACTIVE_SESSIONS` | 2 sessões por worker |
| `JARVIS_MAX_AUDIO_SECONDS_PER_TURN` | 12 s por turno recebido |
| `JARVIS_MAX_SESSION_SECONDS` | 300 s por sessão |
| `JARVIS_SESSION_IDLE_SECONDS` | 45 s após resposta |
| `JARVIS_FOLLOWUP_SECONDS` | 18 s após playback |
| `JARVIS_MAX_TURNS_PER_HOUR` | 120 tentativas por sessão de sala |
| `JARVIS_MAX_WAKE_CHECKS_PER_MINUTE` | 6 verificações externas por worker |
| `JARVIS_LOG_LEVEL` | `info`; aceita `warn`/`error` |

O limite de turnos é reservado antes de abrir uma sessão paga; falhas de conexão
também consomem tentativa. O criador desconectar/reconectar recria a sessão da sala.
Esses contadores não substituem um teto de crédito da ElevenLabs/Brave. A fila de
playback admite quatro respostas, com até 30 s cada, e os streams têm limites de
tempo/tamanho. Há timeout, backpressure e encerramento de sessões ociosas.

Não há banco nem arquivos de voz/transcrições. Consentimentos e contexto são
apenas em memória. `JARVIS_CONSENT_STORAGE_URL` é rejeitada enquanto não existir
implementação durável. A retenção no provedor depende da conta: reveja Audio
Saving/Data Retention e STT; ausência de gravação local não garante retenção zero
na ElevenLabs. Revogar impede novos envios, mas não recolhe áudio já enviado.

Logs mostram só eventos técnicos, horário e incidentes de oito hexadecimais
maiúsculos. `/status` mostra contadores, não valores de créditos ou métricas de
latência inventadas. No diagnóstico, apenas o criador vê contadores por Discord
ID em resposta privada, para verificar atribuição; não se imprime conteúdo falado.
SIGINT/SIGTERM cancelam recepção, uploads, WS, sessões, playback e conexão Discord,
com prazo de saída de 8 s. Não execute duas instâncias com o mesmo bot/guild.

## Elysium e Render

Para salas privadas, siga [docs/ELYSIUM_INTEGRATION.md](docs/ELYSIUM_INTEGRATION.md).
A variável opcional `JARVIS_BOT_USER_ID` pertence ao **Elysium Python**; ela não é
uma credencial do worker. Salas existentes não são migradas automaticamente.

[../render.yaml](../render.yaml) adiciona um Background Worker com `rootDir: jarvis`,
`npm ci && npm run build`, `npm run start` e uma instância. O serviço Python
existente foi preservado. O worker não requer HTTP público ou disco.

**Não sincronize o Blueprint para criar o serviço antes de revisar o custo e
autorizar a contratação/deploy.** `autoDeployTrigger: off` desliga deploys
automáticos posteriores; não impede a criação/deploy inicial do worker pago.
No dashboard do Render, escolha plano/região após os testes, configure as cinco
variáveis privadas e demais opcionais, mantenha uma instância e faça deploy manual
autorizado. Uma implantação com sobreposição de instâncias pode disputar a conexão
do mesmo bot; confirme que o processo anterior terminou antes de iniciar o teste.
Não foi criado ou contratado serviço remoto durante esta implementação.

Após deploy, valide `/status`, `/tone`, `/ask`, matriz DAVE, duas pessoas, wake,
revogação, reconexão e reinicialização. Não aprove o Gate E apenas pelo build.
Veja [Render Workers](https://render.com/docs/background-workers) e
[Blueprint spec](https://render.com/docs/blueprint-spec).
