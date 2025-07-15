import write from '../write.js'

const pingResp = {
  cmd: 'pingresp'
}

function handlePing (client, packet, done) {
  client.broker.emit('ping', packet, client)
  write(client, pingResp, done)
}

export default handlePing
