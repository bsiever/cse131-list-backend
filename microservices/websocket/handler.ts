'use strict';

import { APIGatewayProxyHandler} from 'aws-lambda';
import 'source-map-support/register';


import { validateTokenRequest, validate } from './utility/security';
import { wrapper } from './utility/responses';
import {ErrorTypes, GeneratedError} from './utility/responses';
import { ListWrapper,  refreshAllObserversInLists } from './utility/list';
import { sendMessageToUser, WebSocketMessages } from './utility/websocket';

export const randtoken = require('rand-token');


export const helpNextUser: APIGatewayProxyHandler = async (event, _context): Promise<any> => {
  return wrapper(event, true, async query=> {
    await validateTokenRequest(query);
    const list = new ListWrapper(query.list_id)
    let positionInfo = (await list.getIndexOfUser(query.id));
    if(positionInfo.index !== -1) {
      await list.helpUser(query.id,0,event) //Gets first user
    } else {
      throw new GeneratedError(ErrorTypes.ConnectionNotInSession)
    }
  });
}

export const joinList: APIGatewayProxyHandler = async (event, _context): Promise<any> => {
    return wrapper(event, true, async query=> {
      await validateTokenRequest(query);
      validate(query.remoteURL,'string','remoteURL',0,200);
      const list = new ListWrapper(query.list_id)
      let positionInfo;
      try {
        positionInfo = (await list.getIndexOfUser(query.id));
      } catch {
        //In cases of failure, IE list doesn't exist as it has been closed
        await sendMessageToUser(query.id, event.requestContext.connectionId, '',WebSocketMessages.CloseListSession,event,list);   
        return;
      }
      if(positionInfo.index !== -1) {
        Object.assign(positionInfo, await list.updateConnectionForUser(query.id,event.requestContext.connectionId,query.remoteURL));
      } else {
        positionInfo = await list.addUser(query.id,event.requestContext.connectionId, query.remoteURL, event);
      }
      await sendMessageToUser(query.id, event.requestContext.connectionId, positionInfo,WebSocketMessages.InitalizeSession,event,list);   
    });
}

export const leaveList: APIGatewayProxyHandler = async (event, _context): Promise<any> => {
  return wrapper(event, true, async query=> {
    await validateTokenRequest(query);
    const list = new ListWrapper(query.list_id)
    await list.removeUserFromList(query.id, event);
  });
}

export const flagUser: APIGatewayProxyHandler = async (event, _context): Promise<any> => {
  return wrapper(event, true, async query=> {
    await validateTokenRequest(query);
    const list = new ListWrapper(query.list_id)
    await list.flagUser(query.id, query.studentName, query.message, event);
  });
}

export const helpFlaggedUser: APIGatewayProxyHandler = async (event, _context): Promise<any> => {
  return wrapper(event, true, async query=> {
    await validateTokenRequest(query);
    const list = new ListWrapper(query.list_id)
    await list.helpFlagUser(query.id, query.studentName, query.message, event);
  });
}

export const getFullOverview: APIGatewayProxyHandler = async (event, _context): Promise<any> => {
  return wrapper(event, true, async query=> {
    await validateTokenRequest(query);
    const list = new ListWrapper(query.list_id)
    await list.getFullOverview(query.id, event);
  });
}

/*Scheduled Function(s)*/

export const checkObserverNumbers: APIGatewayProxyHandler = async (event, _context): Promise<any> => {
    await refreshAllObserversInLists(event);
}