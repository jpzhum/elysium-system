from __future__ import annotations

import unittest
from unittest.mock import AsyncMock

from elysium.application import create_bot
from elysium.config import ElysiumConfig
from elysium.constants import CONCLUIR_ENTRADA_CUSTOM_ID
from elysium.constants import (
    PRESENTATION_CREATE_CUSTOM_ID,
    PRESENTATION_DELETE_CUSTOM_ID,
    PRESENTATION_EDIT_CUSTOM_ID,
)
from elysium.errors import send_ephemeral
from elysium.services.role_service import RoleService
from elysium.views.concluir_entrada import ConcluirEntradaView
from elysium.views.presentation_panel import PresentationPanelView
from elysium.views.expedition_panel import ExpeditionPanelView
from elysium.constants import EXPEDITION_CREATE_CUSTOM_ID, EXPEDITION_MINE_CUSTOM_ID


def create_config() -> ElysiumConfig:
    return ElysiumConfig(
        discord_token="ficticio",
        guild_id=100000000000000001,
        habitante_role_id=100000000000000002,
        visitante_role_id=100000000000000003,
        panel_channel_id=100000000000000004,
        port=10000,
    )


class DiscordContractTests(unittest.IsolatedAsyncioTestCase):
    async def test_persistent_view_contract(self) -> None:
        view = ConcluirEntradaView(RoleService(1, 2))
        self.assertIsNone(view.timeout)
        self.assertEqual(view.children[0].custom_id, CONCLUIR_ENTRADA_CUSTOM_ID)
        view.stop()

    async def test_commands_and_intents(self) -> None:
        bot = create_bot(create_config())
        bot.health_server.start = AsyncMock()
        bot.tree.sync = AsyncMock(
            return_value=[
                object(),
                object(),
            ]
        )
        await bot.setup_hook()
        names = {command.name for command in bot.tree.get_commands(guild=bot.guild_object)}
        self.assertIn("publicar_entrada", names)
        self.assertIn("status", names)
        self.assertIn("publicar_apresentacoes", names)
        self.assertIn("publicar_expedicoes", names)
        self.assertIn("boletim", names)
        self.assertIn("sincronizar_salas_expedicao", names)
        self.assertFalse(bot.intents.members)
        self.assertFalse(bot.intents.presences)
        self.assertFalse(bot.intents.message_content)
        self.assertTrue(bot.intents.voice_states)
        await bot.close()

    async def test_expedition_panel_contract(self) -> None:
        bot = create_bot(create_config())
        view = ExpeditionPanelView(bot.config, bot.expedition_service, bot.audit_service)
        self.assertIsNone(view.timeout)
        self.assertEqual(
            [item.custom_id for item in view.children],
            [EXPEDITION_CREATE_CUSTOM_ID, EXPEDITION_MINE_CUSTOM_ID],
        )
        view.stop()
        await bot.close()

    async def test_presentation_persistent_view_contract(self) -> None:
        bot = create_bot(create_config())
        view = PresentationPanelView(bot.config, bot.presentation_service, bot.audit_service)
        self.assertIsNone(view.timeout)
        self.assertEqual(
            [item.custom_id for item in view.children],
            [
                PRESENTATION_CREATE_CUSTOM_ID,
                PRESENTATION_EDIT_CUSTOM_ID,
                PRESENTATION_DELETE_CUSTOM_ID,
            ],
        )
        view.stop()
        await bot.close()

    async def test_ephemeral_response_uses_initial_response(self) -> None:
        interaction = type("Interaction", (), {})()
        interaction.response = type("Response", (), {})()
        interaction.response.is_done = lambda: False
        interaction.response.send_message = AsyncMock()
        interaction.followup = type("Followup", (), {"send": AsyncMock()})()
        await send_ephemeral(interaction, "mensagem")
        interaction.response.send_message.assert_awaited_once_with(
            "mensagem",
            ephemeral=True,
        )
        interaction.followup.send.assert_not_awaited()

    async def test_ephemeral_response_uses_followup_after_response(self) -> None:
        interaction = type("Interaction", (), {})()
        interaction.response = type("Response", (), {})()
        interaction.response.is_done = lambda: True
        interaction.response.send_message = AsyncMock()
        interaction.followup = type("Followup", (), {"send": AsyncMock()})()
        await send_ephemeral(interaction, "mensagem")
        interaction.followup.send.assert_awaited_once_with("mensagem", ephemeral=True)
        interaction.response.send_message.assert_not_awaited()
