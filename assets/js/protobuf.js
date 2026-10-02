/* ==========================================================================
   Minimal protobuf wire-format reader, just enough for GTFS-Realtime.
   Hand-rolled so the app keeps its zero-dependency, ~40 kB footprint.
   ========================================================================== */

class Reader {
  constructor(bytes) {
    this.b = bytes;
    this.p = 0;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  get done() { return this.p >= this.b.length; }
  varint() {
    let result = 0, shift = 0;
    while (this.p < this.b.length) {
      const byte = this.b[this.p++];
      result += (byte & 0x7f) * Math.pow(2, shift);
      if ((byte & 0x80) === 0) break;
      shift += 7;
      if (shift > 63) break;
    }
    return result;
  }
  tag() {
    const key = this.varint();
    return { field: key >>> 3, wire: key & 7 };
  }
  bytes() {
    const len = this.varint();
    const out = this.b.subarray(this.p, this.p + len);
    this.p += len;
    return out;
  }
  string() { return new TextDecoder('utf-8').decode(this.bytes()); }
  float() { const v = this.view.getFloat32(this.p, true); this.p += 4; return v; }
  double() { const v = this.view.getFloat64(this.p, true); this.p += 8; return v; }
  skip(wire) {
    switch (wire) {
      case 0: this.varint(); break;
      case 1: this.p += 8; break;
      case 2: { const l = this.varint(); this.p += l; break; }
      case 5: this.p += 4; break;
      default: this.p = this.b.length;
    }
  }
}

/** Generic: walk a message, returning raw field values. */
function walk(reader, spec) {
  const out = {};
  while (!reader.done) {
    const { field, wire } = reader.tag();
    const kind = spec[field] || null;
    if (!kind) { reader.skip(wire); continue; }
    const key = kind.name;
    switch (kind.type) {
      case 'string': out[key] = reader.string(); break;
      case 'bytes': out[key] = reader.bytes(); break;
      case 'uint': out[key] = reader.varint(); break;
      case 'int': out[key] = reader.varint(); break;
      case 'bool': out[key] = reader.varint() !== 0; break;
      case 'enum': out[key] = reader.varint(); break;
      case 'float': out[key] = reader.float(); break;
      case 'double': out[key] = reader.double(); break;
      case 'message': {
        const r = new Reader(reader.bytes());
        out[key] = kind.decode(r);
        break;
      }
      default: reader.skip(wire);
    }
  }
  return out;
}

const TripDescriptor = {
  1: { name: 'tripId', type: 'string' },
  2: { name: 'routeId', type: 'string' },
  3: { name: 'directionId', type: 'uint' },
  4: { name: 'startTime', type: 'string' },
  5: { name: 'startDate', type: 'string' },
  6: { name: 'scheduleRelationship', type: 'enum' },
};

const VehicleDescriptor = {
  1: { name: 'id', type: 'string' },
  2: { name: 'label', type: 'string' },
  3: { name: 'licensePlate', type: 'string' },
};

const Position = {
  1: { name: 'latitude', type: 'float' },
  2: { name: 'longitude', type: 'float' },
  3: { name: 'bearing', type: 'float' },
  4: { name: 'odometer', type: 'double' },
  5: { name: 'speed', type: 'float' },
};

const VehiclePosition = {
  1: { name: 'trip', type: 'message', decode: (r) => walk(r, TripDescriptor) },
  8: { name: 'vehicle', type: 'message', decode: (r) => walk(r, VehicleDescriptor) },
  2: { name: 'position', type: 'message', decode: (r) => walk(r, Position) },
  3: { name: 'currentStopSequence', type: 'uint' },
  7: { name: 'stopId', type: 'string' },
  4: { name: 'currentStatus', type: 'enum' },
  5: { name: 'timestamp', type: 'uint' },
  6: { name: 'congestionLevel', type: 'enum' },
  9: { name: 'occupancyStatus', type: 'enum' },
};

const StopTimeEvent = {
  1: { name: 'delay', type: 'int' },
  2: { name: 'time', type: 'int' },
  3: { name: 'uncertainty', type: 'int' },
};

const StopTimeUpdate = {
  1: { name: 'stopSequence', type: 'uint' },
  4: { name: 'stopId', type: 'string' },
  2: { name: 'arrival', type: 'message', decode: (r) => walk(r, StopTimeEvent) },
  3: { name: 'departure', type: 'message', decode: (r) => walk(r, StopTimeEvent) },
  5: { name: 'scheduleRelationship', type: 'enum' },
};

const TripUpdate = {
  1: { name: 'trip', type: 'message', decode: (r) => walk(r, TripDescriptor) },
  3: { name: 'vehicle', type: 'message', decode: (r) => walk(r, VehicleDescriptor) },
  2: { name: 'stopTimeUpdate', type: 'message', decode: (r) => walk(r, StopTimeUpdate), repeated: true },
  4: { name: 'timestamp', type: 'uint' },
  5: { name: 'delay', type: 'int' },
};

const Alert = {
  1: { name: 'cause', type: 'enum' },
  2: { name: 'effect', type: 'enum' },
  5: { name: 'headerText', type: 'string' },
  6: { name: 'descriptionText', type: 'string' },
};

const FeedEntity = {
  1: { name: 'id', type: 'string' },
  2: { name: 'isDeleted', type: 'bool' },
  3: { name: 'tripUpdate', type: 'message', decode: (r) => walk(r, TripUpdate) },
  4: { name: 'vehicle', type: 'message', decode: (r) => walk(r, VehiclePosition) },
  5: { name: 'alert', type: 'message', decode: (r) => walk(r, Alert) },
};

/**
 * The 'repeated' spec entries above are collapsed by walk(); patch them up
 * here instead of complicating the generic reader.
 */
function walkRepeated(reader, spec) {
  const out = {};
  while (!reader.done) {
    const { field, wire } = reader.tag();
    const kind = spec[field];
    if (!kind) { reader.skip(wire); continue; }
    if (kind.repeated) {
      const r = new Reader(reader.bytes());
      const item = kind.decode(r);
      if (!out[kind.name]) out[kind.name] = [];
      out[kind.name].push(item);
      continue;
    }
    if (kind.type === 'message') { out[kind.name] = kind.decode(new Reader(reader.bytes())); continue; }
    switch (kind.type) {
      case 'string': out[kind.name] = reader.string(); break;
      case 'uint': case 'int': out[kind.name] = reader.varint(); break;
      case 'bool': out[kind.name] = reader.varint() !== 0; break;
      case 'enum': out[kind.name] = reader.varint(); break;
      case 'float': out[kind.name] = reader.float(); break;
      case 'double': out[kind.name] = reader.double(); break;
      default: reader.skip(wire);
    }
  }
  return out;
}

const Header = {
  1: { name: 'gtfsRealtimeVersion', type: 'string' },
  2: { name: 'incrementality', type: 'enum' },
  3: { name: 'timestamp', type: 'uint' },
};

/** Decode a GTFS-Realtime FeedMessage. */
export function decodeFeedMessage(bytes) {
  const reader = new Reader(bytes);
  const feed = { header: {}, entity: [] };
  while (!reader.done) {
    const { field, wire } = reader.tag();
    if (field === 1) { feed.header = walk(new Reader(reader.bytes()), Header); continue; }
    if (field === 2) { feed.entity.push(walkRepeated(new Reader(reader.bytes()), FeedEntity)); continue; }
    reader.skip(wire);
  }
  return feed;
}

export default { decodeFeedMessage };
