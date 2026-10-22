import { SlashCommandBuilder } from 'discord.js';

export const jarvisCommand = new SlashCommandBuilder()
  .setName('jarvis').setDescription('Converse com Jarvis e controle seu consentimento.')
  .addSubcommand((c) => c.setName('join').setDescription('Criador: conectar Jarvis à sua chamada, sem captar áudio automaticamente.'))
  .addSubcommand((c) => c.setName('leave').setDescription('Criador: desconectar Jarvis e apagar consentimentos da chamada.'))
  .addSubcommand((c) => c.setName('status').setDescription('Ver estado e contadores técnicos, sem conteúdo de conversas.'))
  .addSubcommand((c) => c.setName('tone').setDescription('Criador: testar reprodução com um tom sintético de um segundo.'))
  .addSubcommand((c) => c.setName('privacy').setDescription('Entenda o processamento de texto, áudio e a revogação.'))
  .addSubcommand((c) => c.setName('consent').setDescription('Aceitar interação nesta chamada; áudio exige aceite adicional.')
    .addBooleanOption((o) => o.setName('audio').setDescription('Aceito envio de trechos à ElevenLabs inclusive ANTES de dizer Jarvis.')))
  .addSubcommand((c) => c.setName('revoke').setDescription('Revogar imediatamente: parar sua captura, sessão e reprodução.'))
  .addSubcommand((c) => c.setName('cancel').setDescription('Cancelar suas perguntas na fila, sessão e resposta atual.'))
  .addSubcommand((c) => c.setName('ask').setDescription('Enviar pergunta escrita e receber resposta falada na chamada.')
    .addStringOption((o) => o.setName('texto').setDescription('Sua pergunta para Jarvis (enviada à ElevenLabs).')
      .setRequired(true).setMaxLength(1800)))
  .addSubcommandGroup(g => g.setName('context').setDescription('Gerenciar seu contexto recente temporário desta chamada.')
    .addSubcommand(c => c.setName('status').setDescription('Ver quantidade e prazo do seu contexto curto, sem exibir conteúdo.'))
    .addSubcommand(c => c.setName('clear').setDescription('Apagar seu contexto curto e cancelar suas perguntas em andamento.')));

export function privacyNotice(voiceMode: string, smoke = false, followupSeconds = 18, bargeInEnabled = false,
  shortMemorySeconds = 600): string {
  if (smoke) return 'Modo de diagnóstico DAVE: com /jarvis consent audio:true, seu áudio será decodificado '
    + 'somente em memória para medir duração e RMS. Não é enviado à ElevenLabs nem salvo. '
    + '/jarvis revoke interrompe imediatamente. Reiniciar, sair da chamada ou desconectar apaga o aceite.';
  return 'Jarvis é um bot de IA. Perguntas em /jarvis ask e respostas são processadas pela ElevenLabs. '
    + (voiceMode === 'elevenlabs-stt'
      ? 'Áudio é opcional: /jarvis consent audio:true autoriza enviar os primeiros 4 segundos de trechos '
        + 'de fala à ElevenLabs para detectar Jarvis, inclusive antes da ativação. Após ativar, o turno '
        + `é enviado ao ElevenAgents; há até ${followupSeconds} s de acompanhamento após a resposta. `
        + (bargeInEnabled ? 'Durante respostas, somente o proprietário com aceite de áudio pode enviar '
          + 'trechos de até 4 s para reconhecer os comandos exatos “Jarvis, parar” ou “Jarvis, cancela”. '
          + 'Use fones para reduzir eco. A identidade vem do Discord, nunca do texto reconhecido. ' : '')
      : 'A captura de voz está desativada nesta configuração. Use /jarvis consent e /jarvis ask. ')
    + 'O worker não grava áudio nem transcrição integral da sala; a retenção na ElevenLabs depende da conta. '
    + (shortMemorySeconds > 0 ? `Até 10 interações ativadas ficam em RAM por ${shortMemorySeconds} s, isoladas por conta; `
      + '/jarvis context clear apaga as suas. ' : 'Contexto curto em RAM desativado. ')
    + 'A resposta é audível para quem está na chamada. /jarvis cancel cancela suas perguntas e resposta; '
    + 'Uma ferramenta pode informar ao agente nomes de exibição e presença na sala, sem autorizar captura de áudio de outras pessoas. '
    + '/jarvis revoke para captura/sessão/reprodução imediatamente. '
    + 'O consentimento vale só nesta chamada e é apagado ao sair, desconectar ou reiniciar.';
}
