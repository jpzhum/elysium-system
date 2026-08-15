# Changelog

## Unreleased

### Added
- Pipeline de CI para compilação, `pip check` e testes unitários no Python 3.13.
- Salas de voz temporárias vinculadas às expedições.
- Sincronização automática de participantes.
- Exclusão automática de salas vazias.
- Reconciliação administrativa de salas.
- Estado operacional de salas no comando administrativo `/status`.
- Painel persistente de expedições.
- Criação e edição por modal.
- Participação dinâmica por botões.
- Encerramento com confirmação.
- Componentes dinâmicos compatíveis com reinicializações.
- Índice reconstruível sem banco de dados para expedições.
- Painel persistente de apresentações premium.
- Criação e edição por modal.
- Exclusão com confirmação.
- Índice reconstruível sem banco de dados.
- Auditoria de criação, atualização e exclusão.
- Comando administrativo `/status`.
- Canal privado de auditoria.
- Registro de inicialização, reconexões e conclusões de entrada.
- Tratamento global de erros com códigos de incidente.
- Informações de uptime, versão e latência no comando administrativo `/status`.

### Changed
- `python-dotenv` atualizado para 1.2.2, corrigindo `PYSEC-2026-2270`.
- Logs de inicialização e falha de cargos deixaram de expor IDs configurados.
- Documentação reorganizada para publicação segura do repositório.
- Health check público reduzido à identidade mínima do serviço; detalhes
  operacionais permanecem no comando administrativo `/status`.
- Blueprint do Render alinhado às configurações opcionais de apresentações.
- Versão atualizada para 1.3.1.
- Cartões de expedição ampliados com acesso à sala de voz.
- Versão atualizada para 1.3.0.
