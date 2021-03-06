const AWS = require('aws-sdk');

let currentRegion = 'us-east-1';

if (process.env.TABLE_REGION) currentRegion = process.env.TABLE_REGION;

AWS.config.update({region: currentRegion});

const dynamodb = new AWS.DynamoDB.DocumentClient();

let envStuff = '-main';

var authData = {userId: '', userName: ''};

if (process.env.ENV && process.env.ENV !== 'NONE') {

  envStuff = '-' + process.env.ENV;
}

function loadAuthData(evtObj) {

  console.log('CHECK AUTH', evtObj.requestContext)

  try {
    authData.userId = evtObj.requestContext.authorizer.claims.sub
  } catch (err) {
  }

  try {
    authData.userName = evtObj.requestContext.authorizer.claims.userName
  } catch (err) {
  }

  /*
  try {
    authData.profile = req.apiGateway.event.requestContext.authorizer.claims.profile
  } catch (err){}
  */
}

function routeResponse(event, context) {

  return new Promise((resolve, reject) => {

    // substr removes first /
    let paths = event.path.toLowerCase().substr(1).split('/');

    let handled = null;

    console.log('ROUTING', paths);

    if (event.httpMethod == 'GET') {

      if (paths.length == 2) {

        // GET /events/:companyId
        handled = getRoot(paths[1]).then((resp) => resolve(resp))
      }

      if (paths.length == 3) {

        // GET /events/:companyId/:eventId
        handled = getEventById(paths[1], paths[2]).then((resp) => resolve(resp));

      } else if (paths.length == 4) {

        // GET /events/details/:companyId/:eventId
        handled = getEventById(paths[2], paths[3]).then((resp) => resolve(resp));
      }
    }

    if (event.httpMethod == 'PUT') {

      if (paths.length == 1) {

        // PUT /events
        handled = putEvent(JSON.parse(event.body)).then((resp) => resolve(resp));
      }
    }

    if (!handled) {

      resolve({
        status: 404,
        body: 'Unresolved ' + event.httpMethod + ' route: ' + event.path,
        paths: JSON.stringify(paths)
      });
    }

  });
}

function getRoot(companyId) {

  return new Promise(async (resolve, reject) => {

    console.log('GET_ROOT');

    let queryParams = {
      TableName: 'lodEvents' + envStuff,
      KeyConditionExpression: '#groupName = :groupValue',
      ExpressionAttributeNames: {
        '#groupName': 'companyId'
      },
      ExpressionAttributeValues: {
        ':groupValue': companyId
      }
    }

    dynamodb.query(queryParams, async (err, data) => {

      if (!err) {

        for (let i = 0; i < data.Items.length; i++) {

          console.log('GETTING STREAMS for ' + data.Items[i].id);

          data.Items[i]['streams'] = await getStreamsByEventId(data.Items[i].id);
        }

        resolve({body: data.Items});

      } else {

        resolve({status: 500, error: 'Could not load events: ' + err});
      }
    });
  });
}

async function putEvent(eventObj) {

  console.log('PUT_EVENT', eventObj);

  return new Promise(async (resolve, reject) => {

    loadAuthData(eventObj);

    if (!eventObj.eventName || eventObj.eventName == '') {

      resolve({status: 400, error: 'eventName is required.'});
    }

    if (!eventObj.companyId || eventObj.companyId == '') {

      resolve({status: 400, error: 'companyId is required.'});
    }

    if (!eventObj.eventStatus || eventObj.eventStatus == '') {

      eventObj.eventStatus = 'active';
    }

    if (!eventObj.id || eventObj.id == '') {

      eventObj.id = eventObj.eventName.toLowerCase().latinize().replace(/ /gi, '-');
    }


    let putItemParams = {
      TableName: 'lodEvents' + envStuff,
      Item: {

        id: eventObj.id,
        companyId: eventObj.companyId,
        eventName: eventObj.eventName,
        eventDescription: eventObj.eventDescription,
        startDate: eventObj.startDate,
        endDate: eventObj.endDate,
        creationDate: eventObj.creationDate,
        updatedDate: eventObj.updatedDate,
        updatedUserName: eventObj.updatedUserName,

        logoImgUrl: eventObj.logoImgUrl,

        homeBgImgUrl: eventObj.homeBgImgUrl,
        loginImgUrl: eventObj.loginImgUrl,
        signUpImgUrl: eventObj.signUpImgUrl,

        homeColor: eventObj.homeColor,
        loginColor: eventObj.loginColor,
        signUpColor: eventObj.signUpColor,

        homeBgColor: eventObj.homeBgColor,
        loginBgColor: eventObj.loginBgColor,
        signUpBgColor: eventObj.signUpBgColor,

        streams: []

      }
    }

    dynamodb.put(putItemParams, async (err, data) => {

      console.log('PUT RESULT:', {err, data});

      if (!err) {

        let existingStreams = await getStreamsByEventId(eventObj.id)

        console.log(existingStreams)

        for (let i = 0; i < eventObj.streams.length; i++) {

          let itemIdx = existingStreams.findIndex(s => s.id == eventObj.streams[i].id);

          let flagNewStream = true;

          let stream = {
            id: eventObj.streams[i].id,
            companyId: eventObj.streams[i].companyId,
            eventId: eventObj.streams[i].eventId,

            createdUserId: eventObj.streams[i].createdUserId,

            streamName: eventObj.streams[i].streamName,
            streamStatus: eventObj.streams[i].streamStatus || 'active',

            enabledFromDate: eventObj.streams[i].enabledFromDate,
            enabledToDate: eventObj.streams[i].enabledToDate,

            runningFromDate: eventObj.streams[i].runningFromDate,
            runningToDate: eventObj.streams[i].runningToDate,

            requiresAgreement: (eventObj.streams[i].requiresAgreement),
            agreementUrl: eventObj.streams[i].agreementUrl || '',

            streamVimeoUrl: eventObj.streams[i].streamVimeoUrl || '',
            socialMediaUrl: eventObj.streams[i].socialMediaUrl || ''
          }

          if (itemIdx == -1) {

            // O item I ?? um nova streaming do evento

            stream.id = new Date().getTime();
            stream.eventId = eventObj.id;
            stream.createdUserId = authData.userId;

          } else {

            // O item j?? existe

            flagNewStream = false;

            stream.eventId = existingStreams[itemIdx].eventId;

            stream.createdUserId = existingStreams[itemIdx].createdUserId;
            stream.createdUserName = existingStreams[itemIdx].createdUserName;

            stream.updatedUserId = authData.userId;
            stream.updatedUserName = authData.userName;

            stream.updatedDate = new Date().getTime();

          }

          console.log('PUT SEND:', stream);

          let putResult = await putStream(stream);

          if (flagNewStream) {

            putItemParams.Item.streams.push(putResult);
          } else {

            let itemPosition = putItemParams.Item.streams.findIndex(si => si.id == putResult.id);

            putItemParams.Item.streams[itemPosition] = putResult;
          }

          console.log('PUT RESULT:', putResult);
        }

        for (let i = 0; i < existingStreams.length; i++) {

          let itemToDelete = eventObj.streams.findIndex(s => s.id == existingStreams[i].id);

          if (itemToDelete == -1) {

            console.log('MUST DELETE', existingStreams[i].id)

            await deleteStreamById(existingStreams[i].id, existingStreams[i].eventId)
          }

        }

        resolve({body: putItemParams.Item});

      } else {

        resolve({status: 500, error: err, putObj: putItemParams});

      }
    });

  });
}

function putStream(newItem) {

  return new Promise((resolve, reject) => {

    let putItemParams = {
      TableName: 'lodStreams' + envStuff,
      Item: newItem
    }

    console.log('PUT SEND:', newItem);

    dynamodb.put(putItemParams, (err, data) => {

      if (!err) {

        resolve(newItem);
      } else {

        reject(err);
      }
    })
  })
}

function deleteStreamById(id, eventId) {

  return new Promise((resolve, reject) => {

    let deleteItemParams = {
      TableName: 'lodStreams' + envStuff,
      Key: {
        id: id,
        eventId: eventId
      }
    }

    console.log('DELETE SEND:', deleteItemParams);

    dynamodb.delete(deleteItemParams, (err, data) => {

      if (!err) {

        resolve(data);
      } else {

        reject(err);
      }
    })

  })
}

function getStreamsByEventId(eventId) {

  return new Promise((resolve, reject) => {

    console.log('getStreamByEventId: ' + eventId);

    let queryParams = {
      TableName: 'lodStreams' + envStuff,
      KeyConditionExpression: '#groupName = :groupValue',
      ExpressionAttributeNames: {
        '#groupName': 'eventId'
      },
      ExpressionAttributeValues: {
        ':groupValue': eventId
      }
    }

    dynamodb.query(queryParams, (err, data) => {

      console.log('GET STREAM RESULT: ', {err: err, data: data})

      if (!err) {

        resolve(data.Items);

      } else {

        resolve({status: 500, error: 'Could not load streams by event Id: ' + err});

      }
    });
  });
}

function getEventById(companyId, eventId) {

  return new Promise((resolve, reject) => {

    let queryParams = {
      TableName: 'lodEvents' + envStuff,
      KeyConditionExpression: '#companyIdName = :companyIdValue AND #eventIdName = :eventIdValue',
      ExpressionAttributeNames: {
        '#companyIdName': 'companyId',
        '#eventIdName': 'id'
      },
      ExpressionAttributeValues: {
        ':companyIdValue': companyId,
        ':eventIdValue': eventId
      }
    }

    dynamodb.query(queryParams, async (err, data) => {

      if (!err) {

        if (data.Items.length > 0) {

          let item = data.Items[0];

          item.streams = await getStreamsByEventId(item.id)

          resolve({body: data.Items.length > 0 ? data.Items[0] : null});

        } else {

          resolve({statusCode: 400, error: 'Event not found: ' + eventId})

        }

      } else {

        resolve({statusCode: 500, error: 'Could not load events: ' + err});

      }
    });

  });
}

function getEventDetailsById(companyId, eventId) {

  return new Promise((resolve, reject) => {

    console.log('getEventDetailsById ' + companyId + ', ' + eventId);

    let queryParams = {
      TableName: 'lodEvents' + envStuff,
      KeyConditionExpression: '#groupName = :groupValue AND #idName = :idValue',
      ExpressionAttributeNames: {
        '#groupName': 'companyId',
        '#idName': 'id'
      },
      ExpressionAttributeValues: {
        ':groupValue': companyId,
        ':idValue': eventId
      }
    }

    dynamodb.query(queryParams, (err, data) => {

      if (err) {

        resolve({status: 500, error: 'Could not load event: ' + err});

      } else {

        resolve({body: data.Items[0]});
      }
    });
  });
}

exports.handler = async (event, context, callback) => {

  let response = {
    isBase64Encoded: true,
    statusCode: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*'
    },
    body: JSON.stringify({
      evt: event,
      ctx: context
    }),
  };

  console.log('EVENT ', event);

  let result = await routeResponse(event, context);

  if (result.status && result.status != 200) {
    response.statusCode = result.status;
  }

  console.log('RESULT ', result);

  response.body = JSON.stringify(result.body);

  return response;
};


var Latinise = {};
Latinise.latin_map = {
  "??": "A",
  "??": "A",
  "???": "A",
  "???": "A",
  "???": "A",
  "???": "A",
  "???": "A",
  "??": "A",
  "??": "A",
  "???": "A",
  "???": "A",
  "???": "A",
  "???": "A",
  "???": "A",
  "??": "A",
  "??": "A",
  "??": "A",
  "??": "A",
  "???": "A",
  "??": "A",
  "??": "A",
  "???": "A",
  "??": "A",
  "??": "A",
  "??": "A",
  "??": "A",
  "??": "A",
  "???": "A",
  "??": "A",
  "??": "A",
  "???": "AA",
  "??": "AE",
  "??": "AE",
  "??": "AE",
  "???": "AO",
  "???": "AU",
  "???": "AV",
  "???": "AV",
  "???": "AY",
  "???": "B",
  "???": "B",
  "??": "B",
  "???": "B",
  "??": "B",
  "??": "B",
  "??": "C",
  "??": "C",
  "??": "C",
  "???": "C",
  "??": "C",
  "??": "C",
  "??": "C",
  "??": "C",
  "??": "D",
  "???": "D",
  "???": "D",
  "???": "D",
  "???": "D",
  "??": "D",
  "???": "D",
  "??": "D",
  "??": "D",
  "??": "D",
  "??": "D",
  "??": "DZ",
  "??": "DZ",
  "??": "E",
  "??": "E",
  "??": "E",
  "??": "E",
  "???": "E",
  "??": "E",
  "???": "E",
  "???": "E",
  "???": "E",
  "???": "E",
  "???": "E",
  "???": "E",
  "??": "E",
  "??": "E",
  "???": "E",
  "??": "E",
  "??": "E",
  "???": "E",
  "??": "E",
  "??": "E",
  "???": "E",
  "???": "E",
  "??": "E",
  "??": "E",
  "???": "E",
  "???": "E",
  "???": "ET",
  "???": "F",
  "??": "F",
  "??": "G",
  "??": "G",
  "??": "G",
  "??": "G",
  "??": "G",
  "??": "G",
  "??": "G",
  "???": "G",
  "??": "G",
  "???": "H",
  "??": "H",
  "???": "H",
  "??": "H",
  "???": "H",
  "???": "H",
  "???": "H",
  "???": "H",
  "??": "H",
  "??": "I",
  "??": "I",
  "??": "I",
  "??": "I",
  "??": "I",
  "???": "I",
  "??": "I",
  "???": "I",
  "??": "I",
  "??": "I",
  "???": "I",
  "??": "I",
  "??": "I",
  "??": "I",
  "??": "I",
  "??": "I",
  "???": "I",
  "???": "D",
  "???": "F",
  "???": "G",
  "???": "R",
  "???": "S",
  "???": "T",
  "???": "IS",
  "??": "J",
  "??": "J",
  "???": "K",
  "??": "K",
  "??": "K",
  "???": "K",
  "???": "K",
  "???": "K",
  "??": "K",
  "???": "K",
  "???": "K",
  "???": "K",
  "??": "L",
  "??": "L",
  "??": "L",
  "??": "L",
  "???": "L",
  "???": "L",
  "???": "L",
  "???": "L",
  "???": "L",
  "???": "L",
  "??": "L",
  "???": "L",
  "??": "L",
  "??": "L",
  "??": "LJ",
  "???": "M",
  "???": "M",
  "???": "M",
  "???": "M",
  "??": "N",
  "??": "N",
  "??": "N",
  "???": "N",
  "???": "N",
  "???": "N",
  "??": "N",
  "??": "N",
  "???": "N",
  "??": "N",
  "??": "N",
  "??": "N",
  "??": "NJ",
  "??": "O",
  "??": "O",
  "??": "O",
  "??": "O",
  "???": "O",
  "???": "O",
  "???": "O",
  "???": "O",
  "???": "O",
  "??": "O",
  "??": "O",
  "??": "O",
  "??": "O",
  "???": "O",
  "??": "O",
  "??": "O",
  "??": "O",
  "???": "O",
  "??": "O",
  "???": "O",
  "???": "O",
  "???": "O",
  "???": "O",
  "???": "O",
  "??": "O",
  "???": "O",
  "???": "O",
  "??": "O",
  "???": "O",
  "???": "O",
  "??": "O",
  "??": "O",
  "??": "O",
  "??": "O",
  "??": "O",
  "??": "O",
  "???": "O",
  "???": "O",
  "??": "O",
  "??": "OI",
  "???": "OO",
  "??": "E",
  "??": "O",
  "??": "OU",
  "???": "P",
  "???": "P",
  "???": "P",
  "??": "P",
  "???": "P",
  "???": "P",
  "???": "P",
  "???": "Q",
  "???": "Q",
  "??": "R",
  "??": "R",
  "??": "R",
  "???": "R",
  "???": "R",
  "???": "R",
  "??": "R",
  "??": "R",
  "???": "R",
  "??": "R",
  "???": "R",
  "???": "C",
  "??": "E",
  "??": "S",
  "???": "S",
  "??": "S",
  "???": "S",
  "??": "S",
  "??": "S",
  "??": "S",
  "???": "S",
  "???": "S",
  "???": "S",
  "??": "T",
  "??": "T",
  "???": "T",
  "??": "T",
  "??": "T",
  "???": "T",
  "???": "T",
  "??": "T",
  "???": "T",
  "??": "T",
  "??": "T",
  "???": "A",
  "???": "L",
  "??": "M",
  "??": "V",
  "???": "TZ",
  "??": "U",
  "??": "U",
  "??": "U",
  "??": "U",
  "???": "U",
  "??": "U",
  "??": "U",
  "??": "U",
  "??": "U",
  "??": "U",
  "???": "U",
  "???": "U",
  "??": "U",
  "??": "U",
  "??": "U",
  "???": "U",
  "??": "U",
  "???": "U",
  "???": "U",
  "???": "U",
  "???": "U",
  "???": "U",
  "??": "U",
  "??": "U",
  "???": "U",
  "??": "U",
  "??": "U",
  "??": "U",
  "???": "U",
  "???": "U",
  "???": "V",
  "???": "V",
  "??": "V",
  "???": "V",
  "???": "VY",
  "???": "W",
  "??": "W",
  "???": "W",
  "???": "W",
  "???": "W",
  "???": "W",
  "???": "W",
  "???": "X",
  "???": "X",
  "??": "Y",
  "??": "Y",
  "??": "Y",
  "???": "Y",
  "???": "Y",
  "???": "Y",
  "??": "Y",
  "???": "Y",
  "???": "Y",
  "??": "Y",
  "??": "Y",
  "???": "Y",
  "??": "Z",
  "??": "Z",
  "???": "Z",
  "???": "Z",
  "??": "Z",
  "???": "Z",
  "??": "Z",
  "???": "Z",
  "??": "Z",
  "??": "IJ",
  "??": "OE",
  "???": "A",
  "???": "AE",
  "??": "B",
  "???": "B",
  "???": "C",
  "???": "D",
  "???": "E",
  "???": "F",
  "??": "G",
  "??": "G",
  "??": "H",
  "??": "I",
  "??": "R",
  "???": "J",
  "???": "K",
  "??": "L",
  "???": "L",
  "???": "M",
  "??": "N",
  "???": "O",
  "??": "OE",
  "???": "O",
  "???": "OU",
  "???": "P",
  "??": "R",
  "???": "N",
  "???": "R",
  "???": "S",
  "???": "T",
  "???": "E",
  "???": "R",
  "???": "U",
  "???": "V",
  "???": "W",
  "??": "Y",
  "???": "Z",
  "??": "a",
  "??": "a",
  "???": "a",
  "???": "a",
  "???": "a",
  "???": "a",
  "???": "a",
  "??": "a",
  "??": "a",
  "???": "a",
  "???": "a",
  "???": "a",
  "???": "a",
  "???": "a",
  "??": "a",
  "??": "a",
  "??": "a",
  "??": "a",
  "???": "a",
  "??": "a",
  "??": "a",
  "???": "a",
  "??": "a",
  "??": "a",
  "??": "a",
  "???": "a",
  "???": "a",
  "??": "a",
  "??": "a",
  "???": "a",
  "???": "a",
  "??": "a",
  "???": "aa",
  "??": "ae",
  "??": "ae",
  "??": "ae",
  "???": "ao",
  "???": "au",
  "???": "av",
  "???": "av",
  "???": "ay",
  "???": "b",
  "???": "b",
  "??": "b",
  "???": "b",
  "???": "b",
  "???": "b",
  "??": "b",
  "??": "b",
  "??": "o",
  "??": "c",
  "??": "c",
  "??": "c",
  "???": "c",
  "??": "c",
  "??": "c",
  "??": "c",
  "??": "c",
  "??": "c",
  "??": "d",
  "???": "d",
  "???": "d",
  "??": "d",
  "???": "d",
  "???": "d",
  "??": "d",
  "???": "d",
  "???": "d",
  "???": "d",
  "???": "d",
  "??": "d",
  "??": "d",
  "??": "d",
  "??": "i",
  "??": "j",
  "??": "j",
  "??": "j",
  "??": "dz",
  "??": "dz",
  "??": "e",
  "??": "e",
  "??": "e",
  "??": "e",
  "???": "e",
  "??": "e",
  "???": "e",
  "???": "e",
  "???": "e",
  "???": "e",
  "???": "e",
  "???": "e",
  "??": "e",
  "??": "e",
  "???": "e",
  "??": "e",
  "??": "e",
  "???": "e",
  "??": "e",
  "??": "e",
  "???": "e",
  "???": "e",
  "???": "e",
  "??": "e",
  "???": "e",
  "??": "e",
  "???": "e",
  "???": "e",
  "???": "et",
  "???": "f",
  "??": "f",
  "???": "f",
  "???": "f",
  "??": "g",
  "??": "g",
  "??": "g",
  "??": "g",
  "??": "g",
  "??": "g",
  "??": "g",
  "???": "g",
  "???": "g",
  "??": "g",
  "???": "h",
  "??": "h",
  "???": "h",
  "??": "h",
  "???": "h",
  "???": "h",
  "???": "h",
  "???": "h",
  "??": "h",
  "???": "h",
  "??": "h",
  "??": "hv",
  "??": "i",
  "??": "i",
  "??": "i",
  "??": "i",
  "??": "i",
  "???": "i",
  "???": "i",
  "??": "i",
  "??": "i",
  "???": "i",
  "??": "i",
  "??": "i",
  "??": "i",
  "???": "i",
  "??": "i",
  "??": "i",
  "???": "i",
  "???": "d",
  "???": "f",
  "???": "g",
  "???": "r",
  "???": "s",
  "???": "t",
  "???": "is",
  "??": "j",
  "??": "j",
  "??": "j",
  "??": "j",
  "???": "k",
  "??": "k",
  "??": "k",
  "???": "k",
  "???": "k",
  "???": "k",
  "??": "k",
  "???": "k",
  "???": "k",
  "???": "k",
  "???": "k",
  "??": "l",
  "??": "l",
  "??": "l",
  "??": "l",
  "??": "l",
  "???": "l",
  "??": "l",
  "???": "l",
  "???": "l",
  "???": "l",
  "???": "l",
  "???": "l",
  "??": "l",
  "??": "l",
  "???": "l",
  "??": "l",
  "??": "l",
  "??": "lj",
  "??": "s",
  "???": "s",
  "???": "s",
  "???": "s",
  "???": "m",
  "???": "m",
  "???": "m",
  "??": "m",
  "???": "m",
  "???": "m",
  "??": "n",
  "??": "n",
  "??": "n",
  "???": "n",
  "??": "n",
  "???": "n",
  "???": "n",
  "??": "n",
  "??": "n",
  "???": "n",
  "??": "n",
  "???": "n",
  "???": "n",
  "??": "n",
  "??": "n",
  "??": "nj",
  "??": "o",
  "??": "o",
  "??": "o",
  "??": "o",
  "???": "o",
  "???": "o",
  "???": "o",
  "???": "o",
  "???": "o",
  "??": "o",
  "??": "o",
  "??": "o",
  "??": "o",
  "???": "o",
  "??": "o",
  "??": "o",
  "??": "o",
  "???": "o",
  "??": "o",
  "???": "o",
  "???": "o",
  "???": "o",
  "???": "o",
  "???": "o",
  "??": "o",
  "???": "o",
  "???": "o",
  "???": "o",
  "??": "o",
  "???": "o",
  "???": "o",
  "??": "o",
  "??": "o",
  "??": "o",
  "??": "o",
  "??": "o",
  "???": "o",
  "???": "o",
  "??": "o",
  "??": "oi",
  "???": "oo",
  "??": "e",
  "???": "e",
  "??": "o",
  "???": "o",
  "??": "ou",
  "???": "p",
  "???": "p",
  "???": "p",
  "??": "p",
  "???": "p",
  "???": "p",
  "???": "p",
  "???": "p",
  "???": "p",
  "???": "q",
  "??": "q",
  "??": "q",
  "???": "q",
  "??": "r",
  "??": "r",
  "??": "r",
  "???": "r",
  "???": "r",
  "???": "r",
  "??": "r",
  "??": "r",
  "???": "r",
  "??": "r",
  "???": "r",
  "??": "r",
  "???": "r",
  "???": "r",
  "??": "r",
  "??": "r",
  "???": "c",
  "???": "c",
  "??": "e",
  "??": "r",
  "??": "s",
  "???": "s",
  "??": "s",
  "???": "s",
  "??": "s",
  "??": "s",
  "??": "s",
  "???": "s",
  "???": "s",
  "???": "s",
  "??": "s",
  "???": "s",
  "???": "s",
  "??": "s",
  "??": "g",
  "???": "o",
  "???": "o",
  "???": "u",
  "??": "t",
  "??": "t",
  "???": "t",
  "??": "t",
  "??": "t",
  "???": "t",
  "???": "t",
  "???": "t",
  "???": "t",
  "??": "t",
  "???": "t",
  "???": "t",
  "??": "t",
  "??": "t",
  "??": "t",
  "???": "th",
  "??": "a",
  "???": "ae",
  "??": "e",
  "???": "g",
  "??": "h",
  "??": "h",
  "??": "h",
  "???": "i",
  "??": "k",
  "???": "l",
  "??": "m",
  "??": "m",
  "???": "oe",
  "??": "r",
  "??": "r",
  "??": "r",
  "???": "r",
  "??": "t",
  "??": "v",
  "??": "w",
  "??": "y",
  "???": "tz",
  "??": "u",
  "??": "u",
  "??": "u",
  "??": "u",
  "???": "u",
  "??": "u",
  "??": "u",
  "??": "u",
  "??": "u",
  "??": "u",
  "???": "u",
  "???": "u",
  "??": "u",
  "??": "u",
  "??": "u",
  "???": "u",
  "??": "u",
  "???": "u",
  "???": "u",
  "???": "u",
  "???": "u",
  "???": "u",
  "??": "u",
  "??": "u",
  "???": "u",
  "??": "u",
  "???": "u",
  "??": "u",
  "??": "u",
  "???": "u",
  "???": "u",
  "???": "ue",
  "???": "um",
  "???": "v",
  "???": "v",
  "???": "v",
  "??": "v",
  "???": "v",
  "???": "v",
  "???": "v",
  "???": "vy",
  "???": "w",
  "??": "w",
  "???": "w",
  "???": "w",
  "???": "w",
  "???": "w",
  "???": "w",
  "???": "w",
  "???": "x",
  "???": "x",
  "???": "x",
  "??": "y",
  "??": "y",
  "??": "y",
  "???": "y",
  "???": "y",
  "???": "y",
  "??": "y",
  "???": "y",
  "???": "y",
  "??": "y",
  "???": "y",
  "??": "y",
  "???": "y",
  "??": "z",
  "??": "z",
  "???": "z",
  "??": "z",
  "???": "z",
  "??": "z",
  "???": "z",
  "??": "z",
  "???": "z",
  "???": "z",
  "???": "z",
  "??": "z",
  "??": "z",
  "??": "z",
  "???": "ff",
  "???": "ffi",
  "???": "ffl",
  "???": "fi",
  "???": "fl",
  "??": "ij",
  "??": "oe",
  "???": "st",
  "???": "a",
  "???": "e",
  "???": "i",
  "???": "j",
  "???": "o",
  "???": "r",
  "???": "u",
  "???": "v",
  "???": "x"
};
String.prototype.latinise = function () {
  return this.replace(/[^A-Za-z0-9\[\] ]/g, function (a) {
    return Latinise.latin_map[a] || a
  })
};
String.prototype.latinize = String.prototype.latinise;
String.prototype.isLatin = function () {
  return this == this.latinise()
}
