import {
  Client,
  Events,
  GatewayIntentBits,
  EmbedBuilder,
  ColorResolvable,
} from "discord.js";
import { Sequelize, DataTypes } from "sequelize";
import * as osu from "osu-api-v2-js";
import cron from "node-cron";
import "@dotenvx/dotenvx/config";

const discordToken = process.env.DISCORD_TOKEN;
const channelId = process.env.DISCORD_CHANNEL_ID;
const osuClientId = process.env.OSU_CLIENT_ID as number | undefined;
const osuClientSecret = process.env.OSU_CLIENT_SECRET;
const usernames: (string | number)[] = [12241009, 22248746, 37516721];

if (osuClientId === undefined) {
  throw new Error("OSU_CLIENT_ID is not set");
}

if (osuClientSecret === undefined) {
  throw new Error("OSU_CLIENT_SECRET is not set");
}

if (channelId === undefined) {
  throw new Error("DISCORD_CHANNEL_ID is not set");
}

if (discordToken === undefined) {
  throw new Error("DISCORD_TOKEN is not set");
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const api = await osu.API.createAsync(osuClientId, osuClientSecret);

const users: osu.User[] = [];

for (const name of usernames) {
  const user = await api.getUser(name);
  if (user) {
    users.push(user);
  }
}

const sequelize = new Sequelize({
  dialect: "sqlite",
  storage: "scores.sqlite",
  logging: false,
});

const Score = sequelize.define("Score", {
  userId: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  scoreId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    unique: true,
  },
  gamemode: {
    type: DataTypes.STRING,
    allowNull: false,
  },
});

const colors = {
  X: "#de31ae" as ColorResolvable,
  S: "#02b5c3" as ColorResolvable,
  A: "#88da20" as ColorResolvable,
  B: "#ebbd48" as ColorResolvable,
  C: "#ff8e5d" as ColorResolvable,
  D: "#ff5a5a" as ColorResolvable,
};

const modes = [osu.Ruleset.osu, osu.Ruleset.mania, "fruits", "mania"];
const modeNames = {
  osu: "osu!",
  taiko: "osu!taiko",
  fruits: "osu!catch",
  mania: "osu!mania",
};

await sequelize.sync();

client.on(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}!`);

  // Seconds between requests. This calculation is for an avg of 30 requests per minute.
  const ratelimit = users.length * modes.length * 2;

  cron.schedule(`*/${ratelimit} * * * * *`, async () => {
    const channel = readyClient.channels.cache.get(channelId);

    if (!channel || !channel.isTextBased() || !channel.isSendable()) {
      console.error(
        `Channel with ID ${channelId} not found or is not a text channel.`
      );
      return;
    }

    for (const user of users) {
      for (let mode = 0; mode <= 3; mode++) {
        // console.log("Fetching scores for user", user.username, "in mode", mode);
        const scores = await api.getUserScores(user, "recent", mode);

        for (const score of scores) {
          // console.log("Found score", score.id);
          const exists = await Score.findOne({
            where: {
              userId: score.user.id,
              scoreId: score.id,
              gamemode: score.beatmap.mode,
            },
          });
          if (!exists) {
            await Score.create({
              userId: score.user.id,
              scoreId: score.id,
              gamemode: score.beatmap.mode,
            });
            const embed = createScoreEmbed(fixScore(score as OsuScore));
            await channel.send({
              embeds: [embed],
            });
          }
          const userScores = await Score.findAll({
            where: { userId: user.id, gamemode: score.beatmap.mode },
            order: [["id", "DESC"]],
          });

          if (userScores.length > 10) {
            await Score.destroy({ where: { id: userScores[10].get("id") } });
          }
        }
      }
    }
  });
});

client.login(discordToken);

interface OsuScore extends osu.Score.WithUserBeatmapBeatmapset {
  statistics: OsuScoreStatistics;
}

interface OsuScoreStatistics extends osu.Score.Statistics {
  good: number | undefined;
  perfect: number | undefined;
}

interface OsuScoreFixedStatistics extends osu.Score.Statistics {
  miss: number;
  meh: number;
  ok: number;
  good: number;
  perfect: number;
  great: number;
}

interface OsuScoreFixed extends OsuScore {
  statistics: OsuScoreFixedStatistics
}

function fixScore(score: OsuScore): OsuScoreFixed {
  return {
    ...score,
    statistics: {
      miss: score.statistics.miss ?? 0,
      meh: score.statistics.meh ?? 0,
      ok: score.statistics.ok ?? 0,
      good: score.statistics.good ?? 0,
      perfect: score.statistics.perfect ?? 0,
      great: score.statistics.great ?? 0,
    }
  };
}

function calculateAccuracy(score: OsuScoreFixed) {
  if (score.accuracy !== 0) return score.accuracy;

  if (score.beatmap.mode.includes("mania")) {
    const total_hits = score.statistics.perfect + score.statistics.good + score.statistics.meh + score.statistics.great + score.statistics.ok + score.statistics.miss;
    return ((50 * score.statistics.meh) + (100 * score.statistics.ok) + (200 * score.statistics.good) + (300 * score.statistics.great) + (300 * score.statistics.perfect)) / (total_hits * 300);
  } else {
    const total_hits =  score.statistics.meh + score.statistics.great + score.statistics.ok + score.statistics.miss;
    return ((score.statistics.great * 300) + (score.statistics.ok * 100) + (score.statistics.meh * 50)) / (total_hits * 300);
  }
}

function createScoreEmbed(score: OsuScoreFixed) {
  if (score.beatmap.mode.includes("mania")) {
    return createManiaScoreEmbed(score);
  } else {
    return createGenericScoreEmbed(score);
  }
}

function createGenericScoreEmbed(score: OsuScoreFixed) {
  return new EmbedBuilder()
    .setAuthor({
      name: score.user.username,
      url: `https://osu.ppy.sh/users/${score.user.id}`,
      iconURL: score.user.avatar_url,
    })
    .setTitle(
      `${score.beatmapset.title} - ${score.beatmapset.artist}   ${
        score.beatmap.status.includes("ranked")
          ? `[ ${Math.round(score.pp ?? 0)}pp ]`
          : "[ Unranked ]"
      }`
    )
    .setURL(
      `https://osu.ppy.sh/beatmapsets/${score.beatmapset.id}#${score.beatmap.mode}/${score.beatmap.id}`
    )
    .setDescription(
      `Mods: \`${score.mods.length > 0 ? score.mods.map(mod => mod.acronym).join(", ") : "No Mods"}\``
    )
    .addFields(
      {
        name: "Score",
        value: `\`${score.total_score == 0 ? score.legacy_total_score : score.total_score}\``,
        inline: true,
      },
      {
        name: "Accuracy",
        value: `\`${(calculateAccuracy(score) * 100).toFixed(2)}%\``,
        inline: true,
      },
      {
        name: "Max Combo",
        value: `\`${score.max_combo}\``,
        inline: true,
      }
    )
    .setImage(score.beatmapset.covers["cover@2x"])
    .setThumbnail(
      `https://raw.githubusercontent.com/Yumeo0/osu-icons/refs/heads/main/Grade-${score.rank}.png`
    )
    .setColor(colors[score.rank as keyof typeof colors])
    .setFooter({
      text: modeNames[score.beatmap.mode],
      iconURL: `https://github.com/Yumeo0/osu-icons/blob/main/${score.beatmap.mode}.png?raw=true`,
    })
    .setTimestamp(new Date(score.ended_at));
}

function createManiaScoreEmbed(score: OsuScoreFixed) {
  return new EmbedBuilder()
    .setAuthor({
      name: score.user.username,
      url: `https://osu.ppy.sh/users/${score.user.id}`,
      iconURL: score.user.avatar_url,
    })
    .setTitle(
      `${score.beatmapset.title} - ${score.beatmapset.artist}   ${
        score.beatmap.status.includes("ranked")
          ? `[ ${Math.round(score.pp ?? 0)}pp ]`
          : "[ Unranked ]"
      }`
    )
    .setURL(
      `https://osu.ppy.sh/beatmapsets/${score.beatmapset.id}#${score.beatmap.mode}/${score.beatmap.id}`
    )
    .setDescription(
      `Mods: \`${score.mods.length > 0 ? score.mods.map(mod => mod.acronym).join(", ") : "No Mods"}\``
    )
    .addFields(
      {
        name: "Score",
        value: `\`${score.total_score == 0 ? score.legacy_total_score : score.total_score}\``,
        inline: true,
      },
      {
        name: "Accuracy",
        value: `\`${(calculateAccuracy(score) * 100).toFixed(2)}%\``,
        inline: true,
      },
      {
        name: "Max Combo",
        value: `\`${score.max_combo}\``,
        inline: true,
      },
      {
        name: "",
        value: "",
        inline: false,
      },
      {
        name: "Perfect",
        value: score.statistics.perfect.toString(),
        inline: true,
      },
      {
        name: "Good",
        value: score.statistics.good.toString(),
        inline: true,
      },
      {
        name: "Meh",
        value: score.statistics.meh.toString(),
        inline: true,
      },
      {
        name: "Great",
        value: score.statistics.great.toString(),
        inline: true,
      },
      {
        name: "Ok",
        value: score.statistics.ok.toString(),
        inline: true,
      },
      {
        name: "Miss",
        value: score.statistics.miss.toString(),
        inline: true,
      }
    )
    .setImage(score.beatmapset.covers["cover@2x"])
    .setThumbnail(
      `https://raw.githubusercontent.com/Yumeo0/osu-icons/refs/heads/main/Grade-${score.rank}.png`
    )
    .setColor(colors[score.rank as keyof typeof colors])
    .setFooter({
      text: modeNames[score.beatmap.mode],
      iconURL: `https://github.com/Yumeo0/osu-icons/blob/main/${score.beatmap.mode}.png?raw=true`,
    })
    .setTimestamp(new Date(score.ended_at));
}
