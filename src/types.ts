import { GridPos } from "./maze";
export type messageType = {
  ACTION: string;
  PAYLOAD?: any;
}

export type roomDetails = {
  roomId: string;
  hostId: string;
  status: roomStatus;
  players: Map<string, Player>;
  rematchVotes: Set<string>;
  rematchDeadline: number | null;
  rematchTimer: NodeJS.Timeout | null
}

export type roomStatus = 'IN_LOBBY' | 'STARTED' | 'ENDED';


export type PlayerStatus = 'CONNECTED' | 'DISCONNECTED';

export type Player = {
  socketId: string;
  name: string;
  ready: boolean;
  score: number;
  status: PlayerStatus;
  isHost: boolean;
};

export type GamePlayer = {
  socketId: string;
  name: string;
  pos: GridPos;
  alive: boolean;
  kills: number;
  lastMoveAt: number;
};

export type GameState = {
  roomId: string;
  grid: number[][];
  players: Map<string, GamePlayer>;
  killerId: string;
  killerOrder: string[];      // shuffled list of all socketIds, fixed for the whole game
  killerTurnIndex: number;    // which position in killerOrder is currently active
  rotationTimer: NodeJS.Timeout | null; // handle so we can clear it later (game end, room close, etc)
  startedAt: number;
  durationMs: number;
  disconnectedSocketIds: Set<string>;
};


export const sendEventTypes = {
  HOST_CHANGED: "HOST_CHANGED",
  PLAYER_READY_TOGGLED: "PLAYER_READY_TOGGLED",
  PLAYER_DISCONNECTED: "PLAYER_DISCONNECTED",
  ROOM_UPDATED: "ROOM_UPDATED",
  ROOM_CREATED: "ROOM_CREATED",
  PLAYER_LEFT: "PLAYER_LEFT",
  PLAYER_JOINED: "PLAYER_JOINED",
  NAME_SET: "NAME_SET",
  PLAYER_KICKED: "PLAYER_KICKED",
  ERROR: "ERROR"
};