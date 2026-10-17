// Real ESP32 device node. Install ArduinoJson 7 and select your ESP32 board.
// Pair via POST /v1/nodes/pair with capabilities ["gpio.read","gpio.write"].
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>
const char* WIFI_SSID="REPLACE_ME";
const char* WIFI_PASSWORD="REPLACE_ME";
const char* API_BASE="http://192.168.1.10:4317"; // Trusted local network; use an HTTPS gateway + CA client for remote deployments.
const char* NODE_ID="REPLACE_WITH_PAIRED_NODE_ID";
const char* NODE_TOKEN="REPLACE_WITH_NODE_TOKEN";
const int ALLOWED_PINS[]={2,4};
Preferences state;
bool allowed(int pin){for(int value:ALLOWED_PINS)if(value==pin)return true;return false;}
bool request(const char* method,String route,String body,JsonDocument& result){
 HTTPClient http;http.begin(String(API_BASE)+route);http.addHeader("Authorization",String("Bearer ")+NODE_TOKEN);http.addHeader("Content-Type","application/json");http.setTimeout(10000);
 int status=http.sendRequest(method,body);if(status<200||status>=300){Serial.printf("HTTP %d\n",status);http.end();return false;}auto error=deserializeJson(result,http.getStream());http.end();return !error;
}
bool sendResult(String body){JsonDocument response;return request("POST",String("/v1/nodes/")+NODE_ID+"/result",body,response);}
void setup(){Serial.begin(115200);state.begin("agent-node",false);WiFi.begin(WIFI_SSID,WIFI_PASSWORD);while(WiFi.status()!=WL_CONNECTED)delay(300);}
void loop(){
 if(WiFi.status()!=WL_CONNECTED){delay(1000);return;}
 String pending=state.getString("result","");if(pending.length()){if(sendResult(pending))state.remove("result");delay(200);return;}
 JsonDocument response;if(!request("GET",String("/v1/nodes/")+NODE_ID+"/poll","",response)){delay(1000);return;}
 JsonObject task=response["task"].as<JsonObject>();if(task.isNull()){delay(400);return;}
 String taskId=task["id"].as<String>();JsonDocument result;result["taskId"]=taskId;
 int pin=task["args"]["pin"]|-1;String capability=task["capability"].as<String>();
 if(!allowed(pin)){result["ok"]=false;result["error"]="Pin is not allowed";}
 else if(capability=="gpio.read"){pinMode(pin,INPUT);result["ok"]=true;result["result"]["pin"]=pin;result["result"]["value"]=digitalRead(pin);}
 else if(capability=="gpio.write"){int value=task["args"]["value"]|0;if(value!=0&&value!=1){result["ok"]=false;result["error"]="GPIO value must be 0 or 1";}else{pinMode(pin,OUTPUT);digitalWrite(pin,value?HIGH:LOW);result["ok"]=true;result["result"]["pin"]=pin;result["result"]["value"]=digitalRead(pin);}}
 else{result["ok"]=false;result["error"]="Capability not implemented by this firmware";}
 String body;serializeJson(result,body);state.putString("result",body);if(sendResult(body))state.remove("result");delay(50);
}
