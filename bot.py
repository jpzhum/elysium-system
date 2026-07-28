from __future__ import annotations

import logging
import os
import sys
from typing import Final

import discord
from aiohttp import web
from discord import app_commands
from discord.ext import commands
from dotenv import load_dotenv

load_dotenv()


def read_required_int(name: str) -> int:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"A variável {name} não foi preenchida.")
    try:
        return int(value)
    except ValueError as exc:
        raise RuntimeError(f"A variável {name} precisa conter somente números.") from exc


def read_port() -> int:
    value = os.getenv("PORT", "10000").strip()
    try:
        return int(value)
    except ValueError as exc:
        raise RuntimeError("A variável PORT precisa conter somente números.") from exc


TOKEN: Final[str] = os.getenv("DISCORD_TOKEN", "").strip()
if not TOKEN:
    raise RuntimeError("A variável DISCORD_TOKEN não foi preenchida.")

GUILD_ID: Final[int] = read_required_int("GUILD_ID")
HABITANTE_ROLE_ID: Final[int] = read_required_int("HABITANTE_ROLE_ID")
VISITANTE_ROLE_ID: Final[int] = read_required_int("VISITANTE_ROLE_ID")
PANEL_CHANNEL_ID: Final[int] = read_required_int("PANEL_CHANNEL_ID")
PORT: Final[int] = read_port()

GUILD_OBJECT: Final[discord.Object] = discord.Object(id=GUILD_ID)
BRAND_COLOR: Final[discord.Color] = discord.Color.from_str("#6E7DFF")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
)
logger = logging.getLogger("elysium")


class ConcluirEntradaView(discord.ui.View):
    """Botão persistente: continua registrado depois que o processo reinicia."""

    def __init__(self) -> None:
        super().__init__(timeout=None)

    @discord.ui.button(
        label="Concluir entrada",
        emoji="✅",
        style=discord.ButtonStyle.primary,
        custom_id="elysium:portal:concluir_entrada:v1",
    )
    async def concluir_entrada(
        self,
        interaction: discord.Interaction,
        button: discord.ui.Button,
    ) -> None:
        del button

        if interaction.guild is None or not isinstance(interaction.user, discord.Member):
            await interaction.response.send_message(
                "Este botão só pode ser usado dentro do Elysium.",
                ephemeral=True,
            )
            return

        await interaction.response.defer(ephemeral=True, thinking=True)

        guild = interaction.guild
        member = interaction.user
        habitante = guild.get_role(HABITANTE_ROLE_ID)
        visitante = guild.get_role(VISITANTE_ROLE_ID)
        bot_member = guild.me

        if habitante is None or visitante is None:
            logger.error(
                "Cargo não encontrado. HABITANTE_ROLE_ID=%s VISITANTE_ROLE_ID=%s",
                HABITANTE_ROLE_ID,
                VISITANTE_ROLE_ID,
            )
            await interaction.followup.send(
                "Não consegui localizar os cargos do Portal. Avise a equipe.",
                ephemeral=True,
            )
            return

        if bot_member is None:
            await interaction.followup.send(
                "Não consegui validar as permissões do sistema. Tente novamente em instantes.",
                ephemeral=True,
            )
            return

        if not bot_member.guild_permissions.manage_roles:
            await interaction.followup.send(
                "O Elysium System está sem a permissão **Gerenciar cargos**. Avise a equipe.",
                ephemeral=True,
            )
            return

        highest_target = max(habitante.position, visitante.position)
        if bot_member.top_role.position <= highest_target:
            await interaction.followup.send(
                "O cargo do Elysium System precisa ficar acima de **Habitante** e **Visitante**.",
                ephemeral=True,
            )
            return

        if habitante in member.roles:
            if visitante in member.roles:
                try:
                    await member.remove_roles(
                        visitante,
                        reason=f"Portal concluído novamente por {member} ({member.id})",
                    )
                except (discord.Forbidden, discord.HTTPException):
                    logger.exception("Falha ao remover Visitante de membro já aprovado.")
                    await interaction.followup.send(
                        "Você já possui **Habitante**, mas não consegui remover **Visitante**. "
                        "Avise a equipe.",
                        ephemeral=True,
                    )
                    return

            await interaction.followup.send(
                "Sua entrada já estava concluída. Você já possui o cargo **Habitante**.",
                ephemeral=True,
            )
            return

        try:
            await member.add_roles(
                habitante,
                reason=f"Portal concluído por {member} ({member.id})",
            )
            if visitante in member.roles:
                await member.remove_roles(
                    visitante,
                    reason=f"Portal concluído por {member} ({member.id})",
                )
        except discord.Forbidden:
            logger.exception("Discord recusou a alteração de cargos.")
            await interaction.followup.send(
                "O Discord recusou a alteração dos cargos. Verifique a hierarquia e as permissões do bot.",
                ephemeral=True,
            )
            return
        except discord.HTTPException:
            logger.exception("Erro de comunicação ao alterar cargos.")
            await interaction.followup.send(
                "Ocorreu um erro ao atualizar seus cargos. Tente novamente em alguns segundos.",
                ephemeral=True,
            )
            return

        success_embed = discord.Embed(
            title="Entrada concluída",
            description=(
                "Você recebeu o cargo **Habitante** e agora pode explorar a comunidade.\n\n"
                "Bem-vindo ao Elysium."
            ),
            color=BRAND_COLOR,
        )
        success_embed.set_footer(text="Elysium • A place worth remembering.")
        await interaction.followup.send(embed=success_embed, ephemeral=True)


class ElysiumBot(commands.Bot):
    def __init__(self) -> None:
        intents = discord.Intents.default()
        super().__init__(command_prefix="!", intents=intents)
        self.health_runner: web.AppRunner | None = None

    async def setup_hook(self) -> None:
        await self.start_health_server()
        self.add_view(ConcluirEntradaView())
        synced = await self.tree.sync(guild=GUILD_OBJECT)
        logger.info("%s comando(s) sincronizado(s) no servidor %s.", len(synced), GUILD_ID)

    async def start_health_server(self) -> None:
        app = web.Application()
        app.router.add_get("/", self.health_check)
        app.router.add_get("/health", self.health_check)

        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, host="0.0.0.0", port=PORT)
        await site.start()

        self.health_runner = runner
        logger.info("Servidor de saúde ativo em 0.0.0.0:%s.", PORT)

    async def health_check(self, request: web.Request) -> web.Response:
        del request
        return web.json_response(
            {
                "status": "ok",
                "service": "elysium-system",
                "discord_ready": self.is_ready(),
            }
        )

    async def on_ready(self) -> None:
        if self.user is not None:
            logger.info("Conectado como %s (%s).", self.user, self.user.id)

    async def close(self) -> None:
        if self.health_runner is not None:
            await self.health_runner.cleanup()
            self.health_runner = None
        await super().close()


bot = ElysiumBot()


@bot.tree.command(
    name="publicar_entrada",
    description="Publica o painel oficial para concluir a entrada no Elysium.",
)
@app_commands.guilds(GUILD_OBJECT)
@app_commands.guild_only()
@app_commands.default_permissions(administrator=True)
async def publicar_entrada(interaction: discord.Interaction) -> None:
    if interaction.guild is None or interaction.channel_id != PANEL_CHANNEL_ID:
        await interaction.response.send_message(
            "Use este comando somente no canal **✅・concluir-entrada** configurado.",
            ephemeral=True,
        )
        return

    if not isinstance(interaction.user, discord.Member) or not interaction.user.guild_permissions.administrator:
        await interaction.response.send_message(
            "Somente administradores podem publicar este painel.",
            ephemeral=True,
        )
        return

    embed = discord.Embed(
        title="Conclua sua entrada",
        description=(
            "Finalize sua passagem pelo Portal para acessar a comunidade.\n\n"
            "Antes de continuar:\n"
            "• conheça o **Código**;\n"
            "• escolha seus interesses em **Identidade**;\n"
            "• apresente-se quando se sentir confortável.\n\n"
            "Ao clicar no botão, o cargo **Visitante** será substituído por **Habitante**."
        ),
        color=BRAND_COLOR,
    )
    embed.set_footer(text="Elysium • Sua jornada começa aqui.")

    await interaction.response.send_message(
        embed=embed,
        view=ConcluirEntradaView(),
    )


@publicar_entrada.error
async def publicar_entrada_error(
    interaction: discord.Interaction,
    error: app_commands.AppCommandError,
) -> None:
    logger.exception("Erro no comando /publicar_entrada", exc_info=error)
    message = "Não foi possível publicar o painel. Consulte os logs do serviço."
    if interaction.response.is_done():
        await interaction.followup.send(message, ephemeral=True)
    else:
        await interaction.response.send_message(message, ephemeral=True)


if __name__ == "__main__":
    try:
        bot.run(TOKEN, log_handler=None)
    except KeyboardInterrupt:
        logger.info("Bot encerrado pelo usuário.")
    except Exception:
        logger.exception("O bot foi encerrado por um erro fatal.")
        sys.exit(1)
