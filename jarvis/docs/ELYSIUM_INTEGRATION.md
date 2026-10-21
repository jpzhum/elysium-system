# Jarvis nas salas temporárias do Elysium

Esta integração é opcional. Elysium continua sendo o serviço Python; Jarvis é outro
bot Discord, executado pelo worker Node. O Python administra salas e permissões,
sem conectar à voz nem receber áudio.

## Ativar

1. Instale o bot separado Jarvis no mesmo servidor do Elysium, com permissões de
   visualizar canais, conectar e falar. Não conceda Administrador, Gerenciar cargos
   ou Gerenciar canais ao Jarvis.
2. Copie o **ID de usuário do bot Jarvis**, usando o modo desenvolvedor do Discord.
   Não use o ID do criador, do aplicativo ou de um cargo.
3. Nas variáveis do serviço **Python Elysium**, configure `JARVIS_BOT_USER_ID` com
   esse ID e reinicie o serviço. O valor vazio ou ausente desativa a integração.
   Os tokens e a chave ElevenLabs pertencem exclusivamente ao worker Jarvis.
4. Crie uma nova sala pela expedição. Elysium resolve o membro pelo cache ou por
   consulta REST e confirma seu ID e `member.bot is True` antes de aplicar acesso.
5. Com uma pessoa na sala, teste a entrada do Jarvis pelo comando autorizado do
   worker. Se ocorrer “Sem permissão Connect”, revise a instalação e as permissões
   efetivas do canal. O teste depende do bot Jarvis estar configurado e operacional.

O `.env.example` da raiz contém a configuração vazia. Não versione `.env` nem
copie segredos para documentação ou mensagens.

## Comportamento implementado

- O overwrite específico do Jarvis permite somente `view_channel`, `connect` e
  `speak`. Não adiciona privilégios administrativos.
- Na criação, o limite da sala recebe um slot adicional somente se o membro bot
  tiver sido confirmado e incluído nos overwrites. A edição da capacidade também
  confirma o membro antes de reservar esse slot.
- A capacidade das expedições permanece entre 2 e 12 participantes; com o Jarvis,
  o limite máximo da sala é 13. Isso fica abaixo do máximo de 99 das salas de voz
  documentado na [API oficial do Discord](https://github.com/discord/discord-api-docs/blob/main/developers/resources/channel.mdx).
- Apenas o ID configurado, com `bot is True`, é ignorado na ocupação usada pela
  limpeza. Um humano com ID configurado incorretamente e quaisquer outros bots
  continuam impedindo a exclusão.
- Quando sai a última pessoa e permanece somente Jarvis, a limpeza segue o timeout
  já configurado. A entrada do Jarvis sozinho não cancela esse timeout. A entrada
  de uma pessoa cancela a tarefa; a exclusão verifica novamente a ocupação.
- Encerrar uma expedição que contém somente Jarvis pode excluir sua sala. A
  reconciliação no startup agenda limpeza de salas vazias ou somente com Jarvis,
  preserva salas com pessoas/outros bots e nunca exclui diretamente durante o scan.
- Criações concorrentes da mesma expedição usam o lock existente e produzem uma
  sala. Índices bidirecionais e referências dos cartões continuam sendo usados.
- Se o ID configurado não for de um bot ou a consulta falhar, Elysium registra um
  aviso sanitizado e cria a sala sem acesso/slot adicional para Jarvis. Se um
  overwrite exigido falhar depois da criação, o rollback existente é mantido.

## Limitações operacionais

Permissões são adicionadas somente a salas novas. Ativar a configuração não migra
os overwrites de salas já publicadas. Recrie uma sala vazia pelo fluxo normal ou
revise manualmente suas permissões. Editar a capacidade ajusta o limite, mas não
adiciona o overwrite do Jarvis a salas antigas.

Remover a variável desativa novos acessos e a exceção de ocupação. Isso não remove
overwrites aplicados anteriormente. Antes de desativar, desconecte Jarvis e revise
as permissões antigas se precisar retirar seu acesso. A limpeza preservará uma
sala ocupada pelo bot quando a integração estiver desativada.

A checagem de ocupação não depende do consentimento de áudio: consentimento,
recepção DAVE, sessões ElevenAgents e reprodução são responsabilidades do worker.
A integração Python não demonstra que essas funções estão operacionais.

## Evidências locais

Baseline: `python -m pytest -q` passou com 63 testes e 37 subtests antes do patch.
Os testes adicionais usam objetos/mocks locais e não exigem servidor Discord.
Cobrem configuração opcional e inválida, resolução REST sem intent de membros,
permissões exatas, humano/ID incorreto, falha de consulta, rollback, reserva de
slots, limite máximo, criação concorrente, limpeza, encerramento, eventos de voz,
reconciliação ativa/órfã e preservação de humanos/outros bots.

Comandos de verificação na raiz:

```console
python -m pytest -q
python -m compileall bot.py elysium
python -c "import bot, elysium.application, elysium.config, elysium.constants, elysium.logging_setup, elysium.cogs.portal, elysium.views.concluir_entrada, elysium.services.role_service, elysium.web.health"
```

Nenhuma chamada real, instalação Discord ou alteração remota foi executada por
esses testes. A validação operacional ainda requer credenciais e ambiente de teste.
