# JARVIS Voice

Bot Discord independente, em Node/TypeScript, com ElevenAgents como cérebro,
ASR e voz. Elysium continua no serviço Python. O operador confirmou conexão e
resposta audível de `/ask` em produção. A revisão V4 de turnos consecutivos,
fila e voz experimental ainda exige validação real. Consulte
[IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) antes de operar.

Para falhas de `/join`, timeout de resposta ou ausência de som no Render, consulte
[o roteiro de diagnóstico e validação audível](docs/RENDER_INCIDENTS.md).
Para cinco perguntas consecutivas, voz consentida e barge-in, siga o
[roteiro V4](docs/V4_CONVERSATION_VALIDATION.md).
Para repetição de saudação por microfone, configure First message/overrides e
execute o [roteiro de reconhecimento da pergunta](docs/VOICE_GREETING_VALIDATION.md).
Para identidade por turno, participantes atuais, pesquisa Brave e duplicações de
captura, siga o [deploy e gate real V5](docs/V5_DEPLOY_VALIDATION.md). Essa revisão
adiciona `/status` com etapas completas e `npm run audit:agent` para conferir o
contrato publicado sem imprimir dados privados; aceitação em call permanece pendente.
Para continuidade entre sessões, contexto curto, recuperação de turnos e revisão
da personalidade, siga o [roteiro V5.2](docs/V52_PRODUCTION_VALIDATION.md). A V6 de
PostgreSQL fica para o próximo ciclo, conforme a decisão do operador.

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
| `/jarvis cancel` | Participante: cancela suas perguntas na fila, sessão e resposta; mantém seu consentimento |
| `/jarvis ask texto:...` | Participante consentido na mesma sala: pergunta escrita |
| `/jarvis context status` | Estado e quantidade do seu contexto curto, em resposta privada |
| `/jarvis context clear` | Apaga somente seu contexto curto e cancela suas perguntas atuais; mantém o consentimento |

Participantes não precisam de autorização individual para perguntas. Administração
é aplicada pelo backend comparando IDs; nomes e pedidos falados não concedem
poderes. O bot sai quando não restam humanos. Sair da sala, desconectar ou
reiniciar exige consentimento novo. Revogar também cancela trabalho pendente.

Perguntas são serializadas na chamada, com fila limitada e aviso privado ao
solicitante quando precisam esperar ou são canceladas. Por padrão, cabem oito
perguntas em espera e até duas por participante; a espera expira em 60 s. O
proprietário ganha prioridade entre itens em espera e não corta uma resposta
ativa de convidado. Limite excedido recebe rejeição explícita. Revogação, saída
e cancelamento impedem execução posterior de tarefas daquele participante.

## ElevenLabs

O ajuste V5.4.1 adiciona diagnóstico correlacionado, mediana/p95 por etapa e
comparação privada do prompt publicado. Consulte
[docs/V541_FINE_TUNING.md](docs/V541_FINE_TUNING.md) para evidências, limites das
medições e campos exatos do ElevenLabs a revisar manualmente.

Para a revisão V5.4, veja a investigação, os testes, a configuração manual e o
rollback em [docs/V54_STABILITY_REVIEW.md](docs/V54_STABILITY_REVIEW.md).
O prompt final está em [agent-system-prompt.md](agent-system-prompt.md); sua
preparação local não significa que a versão publicada foi atualizada.

Siga [docs/ELEVENLABS.md](docs/ELEVENLABS.md): agente privado, voz existente
autorizada, português, PCM negociado e evento `agent_response_complete` habilitado.
Copie [agent-system-prompt.md](agent-system-prompt.md) para System prompt. O worker
solicita primeira mensagem vazia por padrão; permita somente o override **First
message** em Security. Não permita override de prompt/tools. Se a conta não
autorizar esse campo, publique First message vazio e configure deliberadamente
`JARVIS_SUPPRESS_FIRST_MESSAGE=false`; não existe fallback automático após uma
recusa. Inclua `user_transcript` nos client events para comprovar reconhecimento
da pergunta dentro do ElevenAgents, sem registrar a transcrição.

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
Capturas menores que um frame de 20 ms ou que resultam em silêncio digital no
downmix são descartadas. Depois do upload completo, o reconhecimento por
`user_transcript` tem prazo próprio de 10 s; se faltar, a sessão é encerrada e a
fila avança. Esse prazo não é o watchdog de geração de 45 s nem o deadline Brave.
O turno enviado inclui a pergunta completa capturada, sem recortar tudo após um
timestamp presumido da wake word. O fim de captura usa 600 ms de silêncio, RMS
mínimo de 0,008 e teto de 12 s por padrão; 600 ms não é a duração total da captura.
O upload usa frames de 20 ms e acrescenta 0,8 s de silêncio. Esses ajustes locais
não substituem o VAD/turn-taking configurado no agente. Os sinais de reconhecimento
e de resposta têm etapas distintas: uma saudação espontânea não comprova que a
fala do usuário virou mensagem conversacional.

O follow-up dura 18 s por padrão após a drenagem local, só para aquele falante.
Essa janela autoriza sua próxima fala sem repetir wake; não confirma conclusão
do provedor. Uma sessão com conclusão explícita pode ser reutilizada; sem esse
sinal, a pergunta seguinte segue a recuperação e pode abrir outra sessão.
Durante playback a captura normal é suprimida para reduzir eco.
O barge-in experimental, habilitado separadamente por
`JARVIS_BARGE_IN_ENABLED=true`, permite apenas ao proprietário com consentimento
de áudio interromper usando os comandos exatos “Jarvis, parar” ou “Jarvis,
cancela”. Não concede autorização por texto ou por declaração verbal. Esse modo
envia ao STT externo trechos consentidos também durante playback, com limite de
duração, cooldown e teto compartilhado de verificações. Fones são recomendados
na validação; as proteções locais não equivalem a cancelamento acústico de eco.
O comando fica vinculado ao stream ouvido durante a captura; um resultado STT
tardio não pode interromper uma resposta nova.
O padrão permanece desabilitado e exige `JARVIS_VOICE_INPUT=elevenlabs-stt`.

Interrupções do provedor cancelam o upload e o áudio daquele turno. PCM recebido segue progressivamente para Opus/Discord,
com conversão contínua, buffers limitados e backpressure. Não é preciso esperar
`agent_response_complete` para ouvir.

Conclusão da geração, fim do recebimento e fim da reprodução são estados distintos.
Se a conclusão faltar e houver outra pergunta esperando, a aplicação pode retirar
a sessão anterior quando recebeu áudio válido, o upload terminou, a fala foi
reconhecida e a saída local drenou, sem ferramenta ou write pendente. Fecha o transporte antigo, drena o áudio aceito
antes do corte e só então inicia a próxima pergunta em sessão isolada. Registra
recuperação em `agent_turns_recovered`, sem contar uma substituição de pergunta
ou declarar geração concluída por silêncio. Isso pode abandonar geração futura
não sinalizada; os pacotes aceitos continuam drenados.

A V5.2 mantém até dez interações consentidas em RAM por sala, vinculadas ao Discord
ID e consentimento. Sessões novas recebem somente contexto do próprio falante,
com prazo e orçamento limitados. Respostas só entram como completas após conclusão
explícita e playback terminado. Na recuperação sem confirmação, pergunta e texto
observado do agente ficam rotulados separadamente, sem afirmar entrega integral.
Revogação, saída, limpeza, expiração e restart removem referências.
Não há memória compartilhada entre contas nem transcrição contínua da sala.

Sem nova pergunta, 45 s sem progresso e sem ferramenta pendente disparam a
recuperação existente, com áudio válido drenado e resultado não confirmado, sem
follow-up. Revogação,
desconexão e expiração cancelam imediatamente. Veja a
[validação V4 no Render](docs/V4_CONVERSATION_VALIDATION.md) e a
[pesquisa do SDK oficial](docs/ELEVENLABS_STREAMING_RESEARCH.md).

O reconhecimento fonético real em PT-BR, falsos wakes, eco, qualidade VAD e
latência da revisão V4 ainda não foram medidos. Os testes de grafias usam texto
sintético; `/ask` audível não aprova entrada de voz. A avaliação de wake acústico
local está no [roteiro V4](docs/V4_CONVERSATION_VALIDATION.md): Porcupine é um
candidato para português; openWakeWord documenta inglês e restrições distintas
para modelos prontos. Nenhum substitui o STT nesta revisão sem benchmark e
análise de licença. Não há latência inferior a dois segundos comprovada.

## Limites, privacidade e parada

| Configuração | Padrão |
| --- | --- |
| `JARVIS_MAX_ACTIVE_SESSIONS` | 2 sessões por worker |
| `JARVIS_SUPPRESS_FIRST_MESSAGE` | `true`; exige permitir somente First message override no agente |
| `JARVIS_MAX_QUEUED_TURNS` | 8 perguntas aguardando por sala |
| `JARVIS_MAX_QUEUED_PER_USER` | 2 perguntas aguardando por participante |
| `JARVIS_QUESTION_QUEUE_TTL_SECONDS` | 60 s em espera; configurável até 120 s |
| `JARVIS_MAX_AUDIO_SECONDS_PER_TURN` | 12 s por turno recebido |
| `JARVIS_MAX_SESSION_SECONDS` | 300 s por sessão |
| `JARVIS_SESSION_IDLE_SECONDS` | 45 s após resposta |
| `JARVIS_SHORT_MEMORY_TTL_SECONDS` | 600 s de contexto em RAM; `0` desabilita, máximo 1800 |
| `JARVIS_FOLLOWUP_SECONDS` | 18 s após playback |
| `JARVIS_MAX_TURNS_PER_HOUR` | 120 tentativas por sessão de sala |
| `JARVIS_MAX_WAKE_CHECKS_PER_MINUTE` | 6 verificações externas por worker |
| `JARVIS_SEARCH_TIMEOUT_MS` | 5000 ms totais para Brave, incluindo leitura da resposta, sem retries |
| `JARVIS_BARGE_IN_ENABLED` | `false`; requer modo `elevenlabs-stt` e aceite de áudio |
| `JARVIS_LOG_LEVEL` | `info`; aceita `warn`/`error` |

O limite de turnos é reservado antes de abrir uma sessão paga; falhas de conexão
também consomem tentativa. O criador desconectar/reconectar recria a sessão da sala.
Esses contadores não substituem um teto de crédito da ElevenLabs/Brave. A fila de
playback admite quatro respostas, com até 120 s de PCM e 384 KiB pendentes por
resposta; o prazo absoluto de 180 s inclui espera na fila e pausas. O adapter tem
outros 384 KiB de PCM e até 64 KiB de texto final pendente por sessão. Limites absolutos cancelam o fluxo e
não significam conclusão. Há backpressure e encerramento de sessões ociosas.

Não há banco nem arquivos de voz/transcrições. Consentimentos e contexto são
apenas em memória. `JARVIS_CONSENT_STORAGE_URL` é rejeitada enquanto não existir
implementação durável. A retenção no provedor depende da conta: reveja Audio
Saving/Data Retention e STT; ausência de gravação local não garante retenção zero
na ElevenLabs. Revogar impede novos envios, mas não recolhe áudio já enviado.
Contexto curto expira sem cortar uma resposta ativa; antes de uma pergunta nova,
o backend renova sockets cujo contexto já venceu. Limpar a RAM não apaga o
histórico remoto do provedor. Veja o [contrato V5.2](docs/V52_PRODUCTION_VALIDATION.md).

Logs mostram só eventos técnicos, horário e incidentes de oito hexadecimais
maiúsculos. As etapas medem fila, abertura/reutilização, primeiro áudio, início e
drenagem de playback e liberação do turno; ausência de evento não vira duração
inventada. `/status` mostra contadores e durações locais agregadas, sem afirmar
latência acústica ou crédito disponível. No diagnóstico, apenas o criador vê contadores por Discord
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

O worker já existente recebe deploy manual do commit revisado. Preserve
plano/região, variáveis privadas e uma instância; não sincronize o Blueprint para
criar outro serviço. `autoDeployTrigger: off` desliga deploys automáticos
posteriores, mas não impede criação inicial de worker. Uma implantação com sobreposição de instâncias pode disputar a conexão
do mesmo bot; confirme que o processo anterior terminou antes de iniciar o teste.
Não foi criado ou contratado serviço remoto durante esta implementação.

Após deploy, valide cinco perguntas consecutivas, `/status`, `/tone`, `/ask`,
matriz DAVE, duas pessoas, wake, revogação, barge-in opcional e reconexão. O
[gate V4](docs/V4_CONVERSATION_VALIDATION.md) exige chamada real; build não o aprova.
Veja [Render Workers](https://render.com/docs/background-workers) e
[Blueprint spec](https://render.com/docs/blueprint-spec).
