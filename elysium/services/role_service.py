from __future__ import annotations

import logging
from dataclasses import dataclass
from enum import Enum, auto

import discord

logger = logging.getLogger("elysium.roles")


class RoleOutcome(Enum):
    SUCCESS = auto()
    ALREADY_APPROVED = auto()
    ROLES_NOT_FOUND = auto()
    BOT_MEMBER_UNAVAILABLE = auto()
    MISSING_PERMISSION = auto()
    INVALID_HIERARCHY = auto()
    ALREADY_APPROVED_REMOVE_FAILED = auto()
    FORBIDDEN = auto()
    HTTP_ERROR = auto()


@dataclass(frozen=True, slots=True)
class RoleResult:
    outcome: RoleOutcome


class RoleService:
    def __init__(self, habitante_role_id: int, visitante_role_id: int) -> None:
        self._habitante_role_id = habitante_role_id
        self._visitante_role_id = visitante_role_id

    async def conclude_entry(
        self,
        guild: discord.Guild,
        member: discord.Member,
    ) -> RoleResult:
        habitante = guild.get_role(self._habitante_role_id)
        visitante = guild.get_role(self._visitante_role_id)

        if habitante is None or visitante is None:
            logger.error("Um ou mais cargos configurados não foram encontrados.")
            return RoleResult(RoleOutcome.ROLES_NOT_FOUND)

        bot_member = guild.me
        if bot_member is None:
            logger.error("Membro do bot indisponível no servidor %s.", guild.id)
            return RoleResult(RoleOutcome.BOT_MEMBER_UNAVAILABLE)

        if not bot_member.guild_permissions.manage_roles:
            logger.warning("Bot sem permissão Gerenciar cargos no servidor %s.", guild.id)
            return RoleResult(RoleOutcome.MISSING_PERMISSION)

        if bot_member.top_role.position <= max(habitante.position, visitante.position):
            logger.warning("Hierarquia de cargos inválida no servidor %s.", guild.id)
            return RoleResult(RoleOutcome.INVALID_HIERARCHY)

        reason = f"Portal concluído por {member} ({member.id})"
        if habitante in member.roles:
            if visitante in member.roles:
                try:
                    await member.remove_roles(
                        visitante,
                        reason=f"Portal concluído novamente por {member} ({member.id})",
                    )
                except (discord.Forbidden, discord.HTTPException):
                    logger.exception(
                        "Falha ao remover Visitante de membro já aprovado %s.", member.id
                    )
                    return RoleResult(RoleOutcome.ALREADY_APPROVED_REMOVE_FAILED)
            logger.info("Entrada já estava concluída para o membro %s.", member.id)
            return RoleResult(RoleOutcome.ALREADY_APPROVED)

        try:
            await member.add_roles(habitante, reason=reason)
            if visitante in member.roles:
                await member.remove_roles(visitante, reason=reason)
        except discord.Forbidden:
            logger.exception("Discord recusou a alteração de cargos do membro %s.", member.id)
            return RoleResult(RoleOutcome.FORBIDDEN)
        except discord.HTTPException:
            logger.exception("Erro de comunicação ao alterar cargos do membro %s.", member.id)
            return RoleResult(RoleOutcome.HTTP_ERROR)

        logger.info("Entrada concluída e cargos atualizados para o membro %s.", member.id)
        return RoleResult(RoleOutcome.SUCCESS)
